import { exec, execSync } from "child_process";
import { promisify } from "util";
import { DisplayStrategy, ScreenInfo } from "./display-strategy.interface";

const execAsync = promisify(exec);

export class X11DisplayStrategy implements DisplayStrategy {
   readonly name = "X11";

   /**
    * Detects DISPLAY and XAUTHORITY at call time (not constructor time)
    * so it picks up changes after reboots / session restarts.
    */
   private getEnvPrefix(): string {
      const display = process.env.DISPLAY || this.detectDisplay();
      const xauth = process.env.XAUTHORITY || this.findXauthority();
      return `DISPLAY=${display} XAUTHORITY=${xauth}`;
   }

   private detectDisplay(): string {
      try {
         const sockets = execSync("ls /tmp/.X11-unix/ 2>/dev/null").toString().trim();
         const match = sockets.match(/X(\d+)/g);
         if (match && match.length > 0) {
            const num = match[match.length - 1].replace("X", "");
            return `:${num}`;
         }
      } catch {}
      return ":0";
   }

   private findXauthority(): string {
      try {
         const uid = execSync("id -u").toString().trim();
         const gdmPath = `/run/user/${uid}/gdm/Xauthority`;
         if (require("fs").existsSync(gdmPath)) return gdmPath;
      } catch {}
      try {
         const home = process.env.HOME || "/root";
         const homePath = `${home}/.Xauthority`;
         if (require("fs").existsSync(homePath)) return homePath;
      } catch {}
      return `${process.env.HOME || "/root"}/.Xauthority`;
   }

   private exec(cmd: string) {
      return execAsync(`${this.getEnvPrefix()} ${cmd}`);
   }

   async getScreenInfo(): Promise<ScreenInfo> {
      const { stdout } = await this.exec("xdpyinfo | grep dimensions | awk '{print $2}'");
      const [w, h] = stdout.trim().split("x").map(Number);
      return { width: w || 1920, height: h || 1080 };
   }

   getStreamUrl(): string {
      return "https://whep.shadijiha.com/screen/whep";
   }

   getScreenshotMimeType(): string {
      return "image/jpeg";
   }

   getScreenshotCommand(): string {
      return `${this.getEnvPrefix()} scrot -p -o /tmp/screen.jpg -q 20 && base64 /tmp/screen.jpg`;
   }

   async mouseMove(x: number, y: number): Promise<void> {
      await this.exec(`xdotool mousemove ${x} ${y}`);
   }

   async mouseClick(x: number, y: number, button: number): Promise<void> {
      await this.exec(`xdotool mousemove ${x} ${y} click ${button}`);
   }

   async mouseDown(x: number, y: number, button: number): Promise<void> {
      await this.exec(`xdotool mousemove ${x} ${y} mousedown ${button}`);
   }

   async mouseUp(x: number, y: number, button: number): Promise<void> {
      await this.exec(`xdotool mousemove ${x} ${y} mouseup ${button}`);
   }

   async mouseScroll(x: number, y: number, scrollY: number): Promise<void> {
      const direction = scrollY > 0 ? 5 : 4;
      await this.exec(`xdotool mousemove ${x} ${y} click ${direction}`);
   }

   async keyPress(key: string): Promise<void> {
      await this.exec(`xdotool key ${X11_KEY_MAP[key] || key}`);
   }

   async typeChar(char: string): Promise<void> {
      await this.exec(`xdotool type --clearmodifiers "${char}"`);
   }
}

const X11_KEY_MAP: Record<string, string> = {
   " ": "space", Enter: "Return", Backspace: "BackSpace", Tab: "Tab",
   Escape: "Escape", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left",
   ArrowRight: "Right", Shift: "shift", Control: "ctrl", Alt: "alt",
   Meta: "super", Delete: "Delete", Home: "Home", End: "End",
   PageUp: "Page_Up", PageDown: "Page_Down",
};
