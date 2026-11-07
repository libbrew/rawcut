import SwiftUI
import WebKit
import UniformTypeIdentifiers

/// Lets Swift talk to the editor page (navigate, send recording events).
@MainActor
final class WebBridge {
    static let shared = WebBridge()
    weak var webView: WKWebView?
    func navigate(_ hash: String) { webView?.evaluateJavaScript("location.hash = \(js(hash))") }
    /// Calls window.rawcutNative(event) in the page.
    func send(_ event: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: event), let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.rawcutNative && window.rawcutNative(\(json))")
    }
    private func js(_ s: String) -> String { "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\"" }
}

struct EditorWebView: NSViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(base: url) }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.isElementFullscreenEnabled = true
        // window.webkit.messageHandlers.rawcut → native screen recorder
        config.userContentController.add(context.coordinator, name: "rawcut")
        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = context.coordinator
        wv.uiDelegate = context.coordinator
        wv.allowsBackForwardNavigationGestures = false
        wv.setValue(false, forKey: "drawsBackground")
        #if DEBUG
        wv.isInspectable = true
        #endif
        WebBridge.shared.webView = wv
        wv.load(URLRequest(url: url))
        return wv
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
        let base: URL
        init(base: URL) { self.base = base }

        // MARK: messages from the page
        func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
            Task { @MainActor in
                switch cmd {
                case "start":
                    ScreenRecorder.shared.begin(mic: body["mic"] as? Bool ?? true, systemAudio: body["sys"] as? Bool ?? true, mode: body["mode"] as? String ?? "display")
                case "stop":
                    ScreenRecorder.shared.finish()
                case "reveal":
                    if let p = body["path"] as? String { NSWorkspace.shared.open(URL(fileURLWithPath: p)) }
                default: break
                }
            }
        }

        // MARK: navigation — keep the app on localhost, open everything else in the browser
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            if action.shouldPerformDownload { return decisionHandler(.download) }
            guard let u = action.request.url else { return decisionHandler(.cancel) }
            if u.host == base.host && u.port == base.port { return decisionHandler(.allow) }
            if ["http", "https", "mailto"].contains(u.scheme ?? "") { NSWorkspace.shared.open(u); return decisionHandler(.cancel) }
            decisionHandler(.allow)
        }
        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
            decisionHandler(response.canShowMIMEType ? .allow : .download)
        }
        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

        // target=_blank links
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let u = action.request.url {
                if u.host == base.host && u.port == base.port && u.path.hasPrefix("/files/") { NSWorkspace.shared.open(u) }
                else { NSWorkspace.shared.open(u) }
            }
            return nil
        }

        // MARK: downloads (Export → Download MP4) go to ~/Downloads via a save panel
        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping @MainActor (URL?) -> Void) {
            let panel = NSSavePanel()
            panel.nameFieldStringValue = suggestedFilename
            panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            panel.begin { completionHandler($0 == .OK ? panel.url : nil) }
        }
        func downloadDidFinish(_ download: WKDownload) {}

        // MARK: JS dialogs and <input type=file>
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
            let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "OK"); a.runModal(); completionHandler()
        }
        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
            let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
            completionHandler(a.runModal() == .alertFirstButtonReturn)
        }
        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (String?) -> Void) {
            let a = NSAlert(); a.messageText = prompt
            let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24)); field.stringValue = defaultText ?? ""
            a.accessoryView = field; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
            completionHandler(a.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
        }
        func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor ([URL]?) -> Void) {
            let panel = NSOpenPanel()
            panel.allowsMultipleSelection = parameters.allowsMultipleSelection
            panel.allowedContentTypes = [.movie, .video, .mpeg4Movie, .quickTimeMovie]
            panel.begin { completionHandler($0 == .OK ? panel.urls : nil) }
        }
        // getUserMedia (if the page ever asks for the mic/camera directly)
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void) {
            decisionHandler(origin.host == base.host ? .grant : .deny)
        }
    }
}
