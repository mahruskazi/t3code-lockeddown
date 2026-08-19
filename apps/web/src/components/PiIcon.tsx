/**
 * PiIcon — official compact badge for the Pi coding agent.
 *
 * [fork:pi] This module is fork-local. Kept out of Icons.tsx so fork
 * updates never conflict there. See docs/internals/fork-pi-provider.md.
 */
import type { Icon } from "./Icons";

export const PiIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 800 800">
    <rect width="800" height="800" rx="120" fill="#09090b" />
    <path
      fill="#fff"
      fillRule="evenodd"
      d="M165.29 165.29h352.07V400H400v117.36H282.65v117.36H165.29V165.29Zm117.36 117.36V400H400V282.65H282.65Z"
    />
    <path fill="#fff" d="M517.36 400h117.36v234.72H517.36V400Z" />
  </svg>
);
