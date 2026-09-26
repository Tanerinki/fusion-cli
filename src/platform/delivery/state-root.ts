import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { failWith } from "../../core/errors.js";

/**
 * O5.5C2.1 — where Fusion keeps delivery state by default: the OS application state of the user running Fusion, never a
 * target repository.
 *
 *   Windows   %LOCALAPPDATA%\Fusion\deliveries        (fallback: <home>\AppData\Local\Fusion\deliveries)
 *   other     $XDG_STATE_HOME/fusion/deliveries       (fallback: <home>/.local/state/fusion/deliveries)
 *
 * The variables are the OS's own conventions, not Fusion switches: a relative, empty or (on Windows) network-share value is
 * ignored and the fallback applies. Whatever the base resolves to, the delivery service refuses a base that overlaps the
 * target repository (after resolving links), so no variable can put the store into the tree it delivers to.
 */
export const DELIVERY_STATE_PATH = Object.freeze({ win32: ["Fusion", "deliveries"] as const, posix: ["fusion", "deliveries"] as const });

export function defaultDeliveryStoreBase(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform,
  home: string = homedir()): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    const usable = typeof local === "string" && win32.isAbsolute(local) && /^[A-Za-z]:[\\/]/u.test(local);
    if (!usable && !/^[A-Za-z]:[\\/]/u.test(home)) failWith("InvalidInput", "No local application-state directory is available for delivery state.");
    return win32.join(win32.resolve(usable ? local! : win32.join(home, "AppData", "Local")), ...DELIVERY_STATE_PATH.win32);
  }
  const state = env.XDG_STATE_HOME;
  const usable = typeof state === "string" && posix.isAbsolute(state);
  if (!usable && !posix.isAbsolute(home)) failWith("InvalidInput", "No application-state directory is available for delivery state.");
  return posix.join(posix.resolve(usable ? state! : posix.join(home, ".local", "state")), ...DELIVERY_STATE_PATH.posix);
}
