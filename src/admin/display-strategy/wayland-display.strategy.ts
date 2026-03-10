import { exec, execSync } from "child_process";
import { promisify } from "util";
import { DisplayStrategy, ScreenInfo } from "./display-strategy.interface";
import { networkInterfaces } from "os";

const execAsync = promisify(exec);

export class WaylandDisplayStrategy implements DisplayStrategy {
   readonly name = "Wayland";
   private readonly waylandEnv: NodeJS.ProcessEnv;

   constructor() {
      this.waylandEnv = { ...process.env };

      // ydotool socket location
      if (!this.waylandEnv.YDOTOOL_SOCKET) {
         this.waylandEnv.YDOTOOL_SOCKET = "/tmp/.ydotool_socket";
      }

      // When launched from SSH/tty, inherit the graphical session's env
      if (!process.env.WAYLAND_DISPLAY) {
         try {
            const uid = execSync("id -u", { encoding: "utf-8" }).trim();
            const runtimeDir = `/run/user/${uid}`;
            const socket = execSync(`ls ${runtimeDir}/wayland-* 2>/dev/null | head -1`, { encoding: "utf-8" }).trim();
            if (socket) {
               this.waylandEnv.WAYLAND_DISPLAY = socket.split("/").pop()!;
               this.waylandEnv.XDG_RUNTIME_DIR = runtimeDir;
            }
         } catch { /* best effort */ }
      }
   }

   async getScreenInfo(): Promise<ScreenInfo> {
      try {
         const { stdout } = await execAsync(
            "gnome-randr 2>/dev/null || wlr-randr 2>/dev/null",
            { env: this.waylandEnv },
         );
         const match = stdout.match(/(\d{3,5})x(\d{3,5})/);
         if (match) return { width: Number(match[1]), height: Number(match[2]) };
      } catch { /* fall through */ }
      return { width: 1920, height: 1080 };
   }

   getStreamUrl(): string {
      const nets = networkInterfaces();
      const ip = Object.values(nets).flat().find((n: any) => n.family === "IPv4" && !n.internal)?.address || "localhost";
      return `http://${ip}:8889/screen/whep`;
   }

   getScreenshotCommand(): string {
      // Build env prefix so the screenshot command inherits Wayland vars
      const envPrefix = this.waylandEnv.WAYLAND_DISPLAY
         ? `WAYLAND_DISPLAY=${this.waylandEnv.WAYLAND_DISPLAY} XDG_RUNTIME_DIR=${this.waylandEnv.XDG_RUNTIME_DIR} `
         : "";
      return `${envPrefix}grim -t jpeg -q 20 /tmp/screen.jpg && base64 /tmp/screen.jpg`;
   }

   async mouseMove(x: number, y: number): Promise<void> {
      await execAsync(`ydotool mousemove -a -x ${x} -y ${y}`, { env: this.waylandEnv });
   }

   async mouseClick(x: number, y: number, button: number): Promise<void> {
      const btnCode = button === 3 ? "0x111" : button === 2 ? "0x112" : "0x110";
      await execAsync(`ydotool mousemove -a -x ${x} -y ${y}`, { env: this.waylandEnv });
      await execAsync(`ydotool click ${btnCode}`, { env: this.waylandEnv });
   }

   async mouseScroll(x: number, y: number, scrollY: number): Promise<void> {
      await execAsync(`ydotool mousemove -a -x ${x} -y ${y}`, { env: this.waylandEnv });
      const amount = scrollY > 0 ? 3 : -3;
      await execAsync(`ydotool mousemove -w -- 0 ${amount}`, { env: this.waylandEnv });
   }

   async keyPress(key: string): Promise<void> {
      const mapped = WAYLAND_KEY_MAP[key];
      if (mapped) {
         await execAsync(`ydotool key ${mapped}`, { env: this.waylandEnv });
      } else {
         await execAsync(`ydotool type "${key}"`, { env: this.waylandEnv });
      }
   }

   async typeChar(char: string): Promise<void> {
      await execAsync(`ydotool type "${char}"`, { env: this.waylandEnv });
   }
}

// ydotool uses Linux input event codes
const WAYLAND_KEY_MAP: Record<string, string> = {
   " ": "57:1 57:0", Enter: "28:1 28:0", Backspace: "14:1 14:0",
   Tab: "15:1 15:0", Escape: "1:1 1:0",
   ArrowUp: "103:1 103:0", ArrowDown: "108:1 108:0",
   ArrowLeft: "105:1 105:0", ArrowRight: "106:1 106:0",
   Shift: "42:1 42:0", Control: "29:1 29:0", Alt: "56:1 56:0",
   Meta: "125:1 125:0", Delete: "111:1 111:0",
   Home: "102:1 102:0", End: "107:1 107:0",
   PageUp: "104:1 104:0", PageDown: "109:1 109:0",
};
