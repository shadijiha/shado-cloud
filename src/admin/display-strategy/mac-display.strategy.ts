import { exec } from "child_process";
import { promisify } from "util";
import { DisplayStrategy, ScreenInfo } from "./display-strategy.interface";

const execAsync = promisify(exec);

export class MacDisplayStrategy implements DisplayStrategy {
   readonly name = "macOS";

   async getScreenInfo(): Promise<ScreenInfo> {
      try {
         const { stdout } = await execAsync("system_profiler SPDisplaysDataType | grep Resolution");
         const match = stdout.match(/(\d{3,5})\s*x\s*(\d{3,5})/);
         if (match) return { width: Number(match[1]), height: Number(match[2]) };
      } catch { /* fall through */ }
      return { width: 1920, height: 1080 };
   }

   getStreamUrl(): string {
      return ""; // MediaMTX not typically used on macOS dev
   }

   getScreenshotMimeType(): string {
      return "image/jpeg";
   }

   getScreenshotCommand(): string {
      return "screencapture -x -t jpg /tmp/screen.jpg && base64 /tmp/screen.jpg";
   }

   async mouseMove(x: number, y: number): Promise<void> {
      await execAsync(`cliclick m:${x},${y}`);
   }

   async mouseClick(x: number, y: number, button: number): Promise<void> {
      const btn = button === 3 ? "rc" : "c";
      await execAsync(`cliclick ${btn}:${x},${y}`);
   }

   async mouseScroll(x: number, y: number, scrollY: number): Promise<void> {
      const dir = scrollY > 0 ? "-" : "+";
      await execAsync(`cliclick m:${x},${y} "scroll:${dir}3"`);
   }

   async keyPress(key: string): Promise<void> {
      const mapped = MAC_KEY_MAP[key];
      await execAsync(`cliclick ${mapped || `t:${key}`}`);
   }

   async typeChar(char: string): Promise<void> {
      await execAsync(`cliclick t:${char}`);
   }

   async getFfmpegCommand(_fps: number): Promise<null> {
      return null; // MediaMTX not typically used on macOS dev
   }
}

const MAC_KEY_MAP: Record<string, string> = {
   Enter: "kp:return", Backspace: "kp:delete", Tab: "kp:tab",
   Escape: "kp:escape", ArrowUp: "kp:arrow-up", ArrowDown: "kp:arrow-down",
   ArrowLeft: "kp:arrow-left", ArrowRight: "kp:arrow-right",
   " ": "kp:space", Delete: "kp:fwd-delete",
};
