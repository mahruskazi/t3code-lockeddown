/**
 * PiIcon — provider icon for the Pi coding agent (π glyph).
 *
 * [fork:pi] This module is fork-local. Kept out of Icons.tsx so fork
 * updates never conflict there. See docs/internals/fork-pi-provider.md.
 */
import { cn } from "~/lib/utils";
import type { Icon } from "./Icons";

export const PiIcon: Icon = ({ className, ...props }) => (
  <svg
    {...props}
    viewBox="0 0 24 24"
    fill="none"
    className={cn("stroke-[#0F0F0F] dark:stroke-[#F5F5F5]", className)}
  >
    <path d="M3.5 7.6C4.6 5.9 6.2 5.6 8 5.6h12.5" strokeWidth="2.4" strokeLinecap="round" />
    <path d="M9.2 5.9V18.4" strokeWidth="2.4" strokeLinecap="round" />
    <path
      d="M16 5.9v9.7c0 1.7 1 2.8 2.4 2.8.8 0 1.5-.3 2.1-.9"
      strokeWidth="2.4"
      strokeLinecap="round"
    />
  </svg>
);
