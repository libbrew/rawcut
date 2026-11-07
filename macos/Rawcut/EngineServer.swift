import Foundation

/// Runs the bundled Rawcut engine (Node + server.js) on localhost and reports its URL.
@MainActor
final class EngineServer: ObservableObject {
    static let shared = EngineServer()
    enum State: Equatable { case starting, running(URL), failed(String) }
    @Published private(set) var state: State = .starting

    private var process: Process?
    private var outputBuffer = ""

    static let dataDir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("Rawcut/data", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()
    static var logFile: URL { dataDir.deletingLastPathComponent().appendingPathComponent("engine.log") }

    var baseURL: URL? { if case .running(let u) = state { return u }; return nil }

    func start() {
        stop()
        state = .starting
        outputBuffer = ""
        guard let res = Bundle.main.resourceURL else { return fail("No app resources.") }
        let engine = res.appendingPathComponent("engine")
        let bundledNode = res.appendingPathComponent("node/node")
        let server = engine.appendingPathComponent("server.js")
        guard FileManager.default.fileExists(atPath: server.path) else {
            return fail("The engine isn't inside the app (\(server.path)). Build the app with Xcode so the \"Bundle Rawcut engine\" step runs.")
        }
        let node = FileManager.default.isExecutableFile(atPath: bundledNode.path) ? bundledNode.path : "/usr/bin/env"

        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = node == "/usr/bin/env" ? ["node", server.path] : [server.path]
        p.currentDirectoryURL = engine
        var env = ProcessInfo.processInfo.environment
        env["RAWCUT_DATA"] = Self.dataDir.path
        env["PORT"] = env["RAWCUT_PORT"] ?? "4777"
        env["RAWCUT_NATIVE"] = "1"
        // So `claude`/`codex` scripts (#!/usr/bin/env node) still work if the user has no Node of their own.
        env["PATH"] = (env["PATH"] ?? "/usr/bin:/bin") + ":" + bundledNode.deletingLastPathComponent().path
        p.environment = env

        FileManager.default.createFile(atPath: Self.logFile.path, contents: nil)
        let log = try? FileHandle(forWritingTo: Self.logFile)
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            guard !data.isEmpty else { return }
            log?.write(data)
            let text = String(decoding: data, as: UTF8.self)
            Task { @MainActor in self?.consume(text) }
        }
        p.terminationHandler = { [weak self] proc in
            Task { @MainActor in
                guard let self, self.process === proc else { return }
                self.process = nil
                self.fail("The engine stopped (exit \(proc.terminationStatus)).\n\n" + String(self.outputBuffer.suffix(3000)))
            }
        }
        do { try p.run(); process = p } catch { fail("Couldn't launch Node: \(error.localizedDescription)") }

        Task { // safety timeout
            try? await Task.sleep(for: .seconds(40))
            if self.state == .starting { self.fail("The engine took too long to start.\n\n" + String(self.outputBuffer.suffix(3000))) }
        }
    }

    private func consume(_ text: String) {
        outputBuffer += text
        if case .starting = state,
           let r = outputBuffer.range(of: #"http://localhost:\d+"#, options: .regularExpression),
           let url = URL(string: String(outputBuffer[r])) {
            state = .running(url)
        }
    }

    private func fail(_ msg: String) { state = .failed(msg) }

    func stop() {
        guard let p = process else { return }
        process = nil
        p.terminationHandler = nil
        if p.isRunning { p.terminate() }
    }
}
