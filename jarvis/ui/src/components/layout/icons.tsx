/** Jeu d'icones minimal, trace en SVG.
 *
 * Aucune librairie: quinze icones ne justifient pas une dependance, et le trait
 * reste coherent avec le reste de l'interface (1,6 px, extremites arrondies).
 */

interface IconProps {
  size?: number;
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export const IconHome = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}><path d="M3 10.2 12 3l9 7.2V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" /></svg>
);
export const IconGrid = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}><rect x="3" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" /></svg>
);
export const IconChat = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4L3 21l1.1-4.6A8.4 8.4 0 1 1 21 11.5z" /></svg>
);
export const IconCalendar = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
);
export const IconMail = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3.5 7 8.5 6 8.5-6" /></svg>
);
export const IconCheck = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}><path d="M9 11l2.5 2.5L16 8" /><rect x="3" y="3" width="18" height="18" rx="3" /></svg>
);
export const IconBuilding = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}><path d="M4 21V6a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v15M12 21V11a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v10M3 21h18M7 9h2M7 13h2M15 14h2M15 17h2" /></svg>
);
export const IconBrain = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}><path d="M12 5.5a3 3 0 0 0-5.9-.7A2.8 2.8 0 0 0 4 9.4a2.9 2.9 0 0 0 .6 4.6A2.8 2.8 0 0 0 8 18.6a2.9 2.9 0 0 0 4 1.6zM12 5.5a3 3 0 0 1 5.9-.7A2.8 2.8 0 0 1 20 9.4a2.9 2.9 0 0 1-.6 4.6A2.8 2.8 0 0 1 16 18.6a2.9 2.9 0 0 1-4 1.6z" /></svg>
);
export const IconPlug = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}><path d="M9 3v6M15 3v6M7 9h10v3a5 5 0 0 1-10 0zM12 17v4" /></svg>
);
export const IconGear = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></svg>
);
export const IconMic = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}><rect x="9" y="2.5" width="6" height="11.5" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5" /></svg>
);
export const IconSearch = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></svg>
);
export const IconExpand = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}><path d="M8 3H4a1 1 0 0 0-1 1v4M16 3h4a1 1 0 0 1 1 1v4M8 21H4a1 1 0 0 1-1-1v-4M16 21h4a1 1 0 0 0 1-1v-4" /></svg>
);
export const IconCollapse = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}><path d="M3 8h4a1 1 0 0 0 1-1V3M21 8h-4a1 1 0 0 1-1-1V3M3 16h4a1 1 0 0 1 1 1v4M21 16h-4a1 1 0 0 0-1 1v4" /></svg>
);
export const IconChevron = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}><path d="m9 5 7 7-7 7" /></svg>
);
export const IconAlert = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}><path d="M12 3.5 2.5 20h19zM12 10v4M12 17h.01" /></svg>
);
export const IconTrash = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}><path d="M4 6h16M9 6V4h6v2M6.5 6l.8 14h9.4l.8-14M10 10.5v6M14 10.5v6" /></svg>
);
