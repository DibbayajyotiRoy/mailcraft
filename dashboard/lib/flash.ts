/** Flash messages for server actions: redirect with `?ok=` (success) next to the existing `?err=`.
 *  Server side:  redirect(withFlash("/domains", "Domain added"))
 *  Client side:  <FlashToast /> in the root layout reads `ok` once and shows a sonner toast. */
export const FLASH_PARAM = "ok";

export function withFlash(to: string, message: string): string {
  return `${to}${to.includes("?") ? "&" : "?"}${FLASH_PARAM}=${encodeURIComponent(message)}`;
}
