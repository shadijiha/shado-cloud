import { execSync } from "child_process";
import { DisplayStrategy } from "./display-strategy.interface";
import { X11DisplayStrategy } from "./x11-display.strategy";
import { WaylandDisplayStrategy } from "./wayland-display.strategy";
import { MacDisplayStrategy } from "./mac-display.strategy";

export class DisplayStrategyFactory {
   /**
    * Detects the current display server and returns the appropriate strategy.
    * Detection order: macOS → Wayland → X11 (default)
    */
   static create(): DisplayStrategy {
      if (process.platform === "darwin") {
         return new MacDisplayStrategy();
      }

      const detected = this.detectSessionType();
      if (detected === "wayland") {
         return new WaylandDisplayStrategy();
      }

      return new X11DisplayStrategy();
   }

   static detectSessionType(): "wayland" | "x11" {
      // Direct env check (works when running inside the graphical session)
      if (process.env.WAYLAND_DISPLAY) return "wayland";
      if (process.env.XDG_SESSION_TYPE === "wayland") return "wayland";
      if (process.env.XDG_SESSION_TYPE === "x11") return "x11";

      // From SSH/tty: query loginctl for the graphical session
      try {
         const sessions = execSync("loginctl list-sessions --no-legend 2>/dev/null", { encoding: "utf-8" }).trim().split("\n");
         for (const line of sessions) {
            const sid = line.trim().split(/\s+/)[0];
            if (!sid) continue;
            const type = execSync(`loginctl show-session ${sid} -p Type --value 2>/dev/null`, { encoding: "utf-8" }).trim();
            if (type === "wayland") return "wayland";
            if (type === "x11") return "x11";
         }
      } catch { /* fall through */ }

      // Process-based fallback
      try {
         const ps = execSync("ps -eo comm 2>/dev/null", { encoding: "utf-8" });
         if (ps.includes("gdm-wayland-ses") || ps.includes("Xwayland")) return "wayland";
      } catch { /* fall through */ }

      return "x11";
   }
}
