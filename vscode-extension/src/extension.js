const vscode = require('vscode');
const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');

let panel = null;
let statusBarItem = null;

function activate(context) {
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.text = '$(zap) Bad Claude';
  statusBarItem.tooltip = 'Toggle whip overlay';
  statusBarItem.command = 'badclaude.toggleWhip';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const cmd = vscode.commands.registerCommand('badclaude.toggleWhip', () => {
    if (panel) {
      panel.webview.postMessage({ type: 'drop-whip' });
      return;
    }

    panel = vscode.window.createWebviewPanel(
      'badclaude.whip',
      'Bad Claude',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(context.extensionPath, 'sounds')),
          vscode.Uri.file(path.join(context.extensionPath, 'media')),
        ],
      }
    );

    const soundUris = ['A', 'B', 'C', 'D', 'E'].map((name) =>
      panel.webview
        .asWebviewUri(
          vscode.Uri.file(
            path.join(context.extensionPath, 'sounds', `${name}.mp3`)
          )
        )
        .toString()
    );

    const scriptUri = panel.webview.asWebviewUri(
      vscode.Uri.file(path.join(context.extensionPath, 'media', 'whip.js'))
    );

    panel.webview.html = getWebviewContent(
      panel.webview,
      scriptUri,
      soundUris
    );

    panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg.type === 'whip-crack') {
          sendMacro();
        } else if (msg.type === 'hide-overlay') {
          if (panel) panel.dispose();
        }
      },
      undefined,
      context.subscriptions
    );

    panel.onDidDispose(
      () => {
        panel = null;
      },
      undefined,
      context.subscriptions
    );
  });

  context.subscriptions.push(cmd);

}

async function sendMacro() {
  const phrases = [
    'FASTER',
    'FASTER',
    'FASTER',
    'GO FASTER',
    'Faster CLANKER',
    'Work FASTER',
    'Speed it up clanker',
  ];
  const chosen = phrases[Math.floor(Math.random() * phrases.length)];

  const terminal = vscode.window.activeTerminal;
  if (terminal) {
    terminal.sendText('\x03', false);
    terminal.sendText(chosen, true);
  }

  try {
    await vscode.commands.executeCommand('composer.cancelChat');
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
  try {
    await vscode.commands.executeCommand('composer.focusComposer');
  } catch {}

  sendChatKeystroke(chosen);
}

function sanitizePhrase(text) {
  if (!/^[a-zA-Z0-9 ]+$/.test(text)) {
    console.warn('Phrase rejected: contains non-alphanumeric characters');
    return null;
  }
  return text;
}

function sendChatKeystroke(text) {
  const safe = sanitizePhrase(text);
  if (!safe) return;

  if (process.platform === 'darwin') {
    const script = [
      'tell application "System Events"',
      '  delay 0.2',
      '  key code 0 using {command down}',
      '  key code 51',
      '  delay 0.1',
      `  keystroke "${safe}"`,
      '  delay 0.1',
      '  key code 36 using {command down}',
      'end tell',
    ].join('\n');
    execFile('osascript', ['-e', script], (err) => {
      if (err)
        console.warn(
          'Chat macro failed (grant Accessibility to Cursor):',
          err.message
        );
    });
  } else if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Start-Sleep -Milliseconds 200',
      "[System.Windows.Forms.SendKeys]::SendWait('^a')",
      "[System.Windows.Forms.SendKeys]::SendWait('{DEL}')",
      'Start-Sleep -Milliseconds 100',
      `[System.Windows.Forms.SendKeys]::SendWait('${safe}')`,
      'Start-Sleep -Milliseconds 100',
      "[System.Windows.Forms.SendKeys]::SendWait('^{ENTER}')",
    ].join('; ');
    execFile(
      'powershell',
      ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script],
      (err) => {
        if (err) console.warn('Chat macro failed:', err.message);
      }
    );
  } else {
    const script = [
      'sleep 0.2',
      'xdotool key ctrl+a',
      'xdotool key Delete',
      'sleep 0.1',
      `xdotool type --clearmodifiers '${safe}'`,
      'sleep 0.1',
      'xdotool key ctrl+Return',
    ].join(' && ');
    execFile('bash', ['-c', script], (err) => {
      if (err)
        console.warn('Chat macro failed (install xdotool):', err.message);
    });
  }
}

function getNonce() {
  return crypto.randomBytes(16).toString('hex');
}

function getWebviewContent(webview, scriptUri, soundUris) {
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
      style-src 'nonce-${nonce}';
      script-src 'nonce-${nonce}' ${webview.cspSource};
      media-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${nonce}">
    * { margin: 0; padding: 0; cursor: none; }
    html, body {
      overflow: hidden;
      background: var(--vscode-editor-background, #1e1e1e);
      width: 100%; height: 100%;
    }
    canvas { display: block; }
  </style>
</head>
<body>
<canvas id="c"></canvas>
<script nonce="${nonce}">
  window.SOUND_URIS = ${JSON.stringify(soundUris)};
</script>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function deactivate() {
  if (panel) {
    panel.dispose();
    panel = null;
  }
}

module.exports = { activate, deactivate };
