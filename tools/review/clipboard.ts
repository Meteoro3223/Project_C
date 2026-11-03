import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function removeQuietly(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // The temporary directory is best-effort cleanup; the clipboard already has the text.
  }
}

/**
 * Copies text to the Windows clipboard without going through a console code
 * page. PowerShell's stdin encoding is decided before the command runs, so the
 * packet is written to a UTF-8 temp file and read back with an explicit UTF-8
 * encoding. `clip.exe` was tried with UTF-8 stdin and mangles non-ASCII text
 * (for example "áéíóúñ ×") on some Windows configurations.
 */
export function copyToClipboard(text: string): Promise<boolean> {
  if (process.platform !== "win32") {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let tempDir: string | null = null;

    const finish = (value: boolean): void => {
      if (tempDir !== null) {
        removeQuietly(tempDir);
        tempDir = null;
      }
      resolve(value);
    };

    try {
      tempDir = mkdtempSync(path.join(os.tmpdir(), "proyecto-c-review-"));
      const packetPath = path.join(tempDir, "packet.txt");
      writeFileSync(packetPath, text, "utf8");

      const escapedPath = packetPath.replaceAll("'", "''");
      const command = `Set-Clipboard -Value ([IO.File]::ReadAllText('${escapedPath}', [Text.Encoding]::UTF8))`;

      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-STA", "-Command", command],
        { stdio: ["ignore", "ignore", "ignore"], windowsHide: true },
      );

      child.on("error", () => {
        finish(false);
      });
      child.on("close", (exitCode) => {
        finish(exitCode === 0);
      });
    } catch {
      finish(false);
    }
  });
}
