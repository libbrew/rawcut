import SwiftUI

@main
struct RawcutApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var server = EngineServer.shared

    var body: some Scene {
        WindowGroup("Rawcut") {
            RootView()
                .environmentObject(server)
                .frame(minWidth: 960, minHeight: 640)
                .background(Color(red: 0.05, green: 0.05, blue: 0.06))
        }
        .windowStyle(.titleBar)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandMenu("Rawcut") {
                Button("Record") { WebBridge.shared.navigate("#/record") }.keyboardShortcut("r", modifiers: [.command, .shift])
                Button("Projects") { WebBridge.shared.navigate("#/projects") }.keyboardShortcut("p", modifiers: [.command, .shift])
                Button("Settings…") { WebBridge.shared.navigate("#/settings") }.keyboardShortcut(",", modifiers: .command)
                Divider()
                Button("Show Data Folder") { NSWorkspace.shared.open(EngineServer.dataDir) }
                Button("Show Engine Log") { NSWorkspace.shared.open(EngineServer.logFile) }
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) { EngineServer.shared.start() }
    func applicationWillTerminate(_ notification: Notification) { EngineServer.shared.stop() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

struct RootView: View {
    @EnvironmentObject var server: EngineServer
    var body: some View {
        switch server.state {
        case .starting:
            VStack(spacing: 14) {
                Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 72, height: 72)
                ProgressView().controlSize(.small)
                Text("Starting Rawcut…").foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        case .running(let url):
            EditorWebView(url: url)
        case .failed(let message):
            VStack(spacing: 12) {
                Text("Rawcut's engine couldn't start").font(.title2.bold())
                ScrollView { Text(message).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                    .frame(maxWidth: 640, maxHeight: 240)
                HStack {
                    Button("Try Again") { server.start() }.keyboardShortcut(.defaultAction)
                    Button("Open Log") { NSWorkspace.shared.open(EngineServer.logFile) }
                }
            }.padding(40).frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
