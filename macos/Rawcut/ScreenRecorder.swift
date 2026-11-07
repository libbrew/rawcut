import Foundation
import ScreenCaptureKit
import AVFoundation
import AppKit

/// Native screen recording with ScreenCaptureKit: the macOS system picker, system audio and
/// microphone, written straight to an .mp4. When it stops, the file is handed to the engine.
@MainActor
final class ScreenRecorder: NSObject, SCContentSharingPickerObserver, SCStreamDelegate, SCRecordingOutputDelegate {
    static let shared = ScreenRecorder()

    private var stream: SCStream?
    private var output: SCRecordingOutput?
    private var fileURL: URL?
    private var wantMic = true, wantSystem = true
    private var started: Date?

    func begin(mic: Bool, systemAudio: Bool, mode: String = "display") {
        guard stream == nil else { return }
        wantMic = mic; wantSystem = systemAudio
        Task {
            if mic { _ = await AVCaptureDevice.requestAccess(for: .audio) }
            let picker = SCContentSharingPicker.shared
            var cfg = SCContentSharingPickerConfiguration()
            cfg.allowedPickerModes = mode == "window" ? [.singleWindow] : mode == "app" ? [.singleApplication] : [.singleDisplay, .singleWindow, .singleApplication]
            cfg.allowsChangingSelectedContent = false
            picker.defaultConfiguration = cfg
            picker.add(self)
            picker.isActive = true
            picker.present()
            WebBridge.shared.send(["event": "picking"])
        }
    }

    func finish() {
        guard let stream else { return }
        WebBridge.shared.send(["event": "saving"])
        Task { try? await stream.stopCapture() } // recordingOutputDidFinishRecording fires next
    }

    // MARK: picker
    nonisolated func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
        Task { @MainActor in self.startCapture(filter) }
    }
    nonisolated func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {
        Task { @MainActor in self.closePicker(); WebBridge.shared.send(["event": "cancelled"]) }
    }
    nonisolated func contentSharingPickerStartDidFailWithError(_ error: Error) {
        Task { @MainActor in self.closePicker(); self.report(error) }
    }
    private func closePicker() { SCContentSharingPicker.shared.remove(self); SCContentSharingPicker.shared.isActive = false }

    private func startCapture(_ filter: SCContentFilter) {
        guard stream == nil else { return }
        closePicker()
        let scale = CGFloat(filter.pointPixelScale)
        var w = Int(filter.contentRect.width * scale), h = Int(filter.contentRect.height * scale)
        // Keep it at most 1920 wide (the editor normalises to that anyway) and even-sized for H.264.
        if w > 1920 { h = Int(Double(h) * 1920 / Double(w)); w = 1920 }
        w -= w % 2; h -= h % 2

        let c = SCStreamConfiguration()
        c.width = max(w, 2); c.height = max(h, 2)
        c.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        c.showsCursor = true
        c.queueDepth = 6
        c.capturesAudio = wantSystem
        c.excludesCurrentProcessAudio = true
        c.captureMicrophone = wantMic
        c.sampleRate = 48000
        c.channelCount = 2

        let url = FileManager.default.temporaryDirectory.appendingPathComponent("rawcut-\(Int(Date().timeIntervalSince1970)).mp4")
        let oc = SCRecordingOutputConfiguration()
        oc.outputURL = url
        oc.outputFileType = .mp4
        oc.videoCodecType = .h264

        let s = SCStream(filter: filter, configuration: c, delegate: self)
        let o = SCRecordingOutput(configuration: oc, delegate: self)
        do { try s.addRecordingOutput(o) } catch { return report(error) }
        stream = s; output = o; fileURL = url
        Task {
            do {
                try await s.startCapture()
                started = Date()
                WebBridge.shared.send(["event": "recording"])
            } catch { self.reset(); self.report(error) }
        }
    }

    // MARK: stream / recording callbacks
    nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
        // The user pressed "Stop sharing" in the menu bar: keep what was recorded.
        Task { @MainActor in if self.output == nil { self.report(error) } }
    }
    nonisolated func recordingOutputDidStartRecording(_ recordingOutput: SCRecordingOutput) {}
    nonisolated func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) {
        Task { @MainActor in self.reset(); self.report(error) }
    }
    nonisolated func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) {
        Task { @MainActor in
            guard let url = self.fileURL else { return }
            let secs = Date().timeIntervalSince(self.started ?? Date())
            self.reset()
            await self.handOff(url, seconds: secs)
        }
    }

    private func reset() { stream = nil; output = nil; started = nil }

    private func report(_ error: Error) {
        var msg = error.localizedDescription
        if (error as NSError).code == -3801 || msg.localizedCaseInsensitiveContains("declined") {
            msg = "Rawcut needs Screen Recording permission. Open System Settings → Privacy & Security → Screen & System Audio Recording, turn on Rawcut, then try again."
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
        }
        WebBridge.shared.send(["event": "error", "message": msg])
    }

    /// Upload the finished file to the engine, start the AI analysis and open the editor.
    private func handOff(_ file: URL, seconds: Double) async {
        guard let base = EngineServer.shared.baseURL else { return }
        WebBridge.shared.send(["event": "uploading"])
        do {
            var comps = URLComponents(url: base.appendingPathComponent("api/projects"), resolvingAgainstBaseURL: false)!
            let name = "Screen recording " + DateFormatter.localizedString(from: Date(), dateStyle: .medium, timeStyle: .short)
            comps.queryItems = [URLQueryItem(name: "name", value: name), URLQueryItem(name: "ext", value: "mp4")]
            var req = URLRequest(url: comps.url!); req.httpMethod = "POST"
            let (data, _) = try await URLSession.shared.upload(for: req, fromFile: file)
            guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any], let id = obj["id"] as? String else {
                throw NSError(domain: "Rawcut", code: 1, userInfo: [NSLocalizedDescriptionKey: String(decoding: data, as: UTF8.self)])
            }
            var an = URLRequest(url: base.appendingPathComponent("api/projects/\(id)/analyze"))
            an.httpMethod = "POST"; an.setValue("application/json", forHTTPHeaderField: "content-type"); an.httpBody = Data("{}".utf8)
            _ = try await URLSession.shared.data(for: an)
            try? FileManager.default.removeItem(at: file)
            WebBridge.shared.send(["event": "done", "id": id, "seconds": seconds])
        } catch {
            WebBridge.shared.send(["event": "error", "message": "Saved the recording but couldn't open it in the editor: \(error.localizedDescription). The file is at \(file.path)"])
        }
    }
}
