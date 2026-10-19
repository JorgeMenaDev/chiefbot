import { AvatarColor, AvatarShape, type BotAvatar } from "@chiefbot/contracts";
import { cn } from "./lib/utils.ts";

// A bot's face: a flat shape in one colour with the Fleet chief's two capsule eyes.
// Each shape is one path on a 100x100 grid. `eyes` is where its eyes sit: centre x and y,
// tilt in degrees and scale (1 = two 12x25 capsules, 26 apart, as on the Fleet chief).
const shapes: Record<AvatarShape, { label: string; eyes: [number, number, number, number]; d: string }> = {
  chief: { label: "Chief", eyes: [50, 50, 0, 1], d: "M7 69L7 31A17 17 0 0 1 24 14L76 14A17 17 0 0 1 93 31L93 69A17 17 0 0 1 76 86L24 86A17 17 0 0 1 7 69Z" },
  circle: { label: "Circle", eyes: [54, 46, 8, 1], d: "M7 50a43 43 0 1 1 86 0a43 43 0 1 1 -86 0Z" },
  card: { label: "Card", eyes: [51, 50, 12, 1], d: "M9.65 61.87L17.97 22.74A17 17 0 0 1 38.13 9.65L77.26 17.97A17 17 0 0 1 90.35 38.13L82.03 77.26A17 17 0 0 1 61.87 90.35L22.74 82.03A17 17 0 0 1 9.65 61.87Z" },
  cloud: { label: "Cloud", eyes: [55, 58, -4, 0.95], d: "M12 58a21 21 0 1 1 42 0a21 21 0 1 1 -42 0ZM31 44a27 27 0 1 1 54 0a27 27 0 1 1 -54 0ZM55 63a18 18 0 1 1 36 0a18 18 0 1 1 -36 0ZM14 68L14 68A12 12 0 0 1 26 56L76 56A12 12 0 0 1 88 68L88 68A12 12 0 0 1 76 80L26 80A12 12 0 0 1 14 68Z" },
  hexagon: { label: "Hexagon", eyes: [50, 52, -6, 1], d: "M14.8 23.32L44.5 6.18A11 11 0 0 1 55.5 6.18L85.2 23.32A11 11 0 0 1 90.7 32.85L90.7 67.15A11 11 0 0 1 85.2 76.68L55.5 93.82A11 11 0 0 1 44.5 93.82L14.8 76.68A11 11 0 0 1 9.3 67.15L9.3 32.85A11 11 0 0 1 14.8 23.32Z" },
  flower: { label: "Flower", eyes: [50, 50, 0, 0.95], d: "M33 22a17 17 0 1 1 34 0a17 17 0 1 1 -34 0ZM57.25 36a17 17 0 1 1 34 0a17 17 0 1 1 -34 0ZM57.25 64a17 17 0 1 1 34 0a17 17 0 1 1 -34 0ZM33 78a17 17 0 1 1 34 0a17 17 0 1 1 -34 0ZM8.75 64a17 17 0 1 1 34 0a17 17 0 1 1 -34 0ZM8.75 36a17 17 0 1 1 34 0a17 17 0 1 1 -34 0ZM22 50a28 28 0 1 1 56 0a28 28 0 1 1 -56 0Z" },
  star: { label: "Star", eyes: [50, 56, -4, 0.82], d: "M36.68 31.17L42.93 19.37A8 8 0 0 1 57.07 19.37L63.32 31.17A6 6 0 0 0 67.59 34.28L80.75 36.57A8 8 0 0 1 85.12 50.02L75.82 59.61A6 6 0 0 0 74.19 64.64L76.08 77.86A8 8 0 0 1 64.64 86.18L52.64 80.3A6 6 0 0 0 47.36 80.3L35.36 86.18A8 8 0 0 1 23.92 77.86L25.81 64.64A6 6 0 0 0 24.18 59.61L14.88 50.02A8 8 0 0 1 19.25 36.57L32.41 34.28A6 6 0 0 0 36.68 31.17Z" },
  drop: { label: "Drop", eyes: [46, 58, 28, 0.95], d: "M70.66 11.15C70.66 11.15 83.78 58.9 74.39 76.56C65.47 93.33 45.18 99.54 28.4 90.62C11.63 81.7 5.43 61.41 14.35 44.63C23.74 26.97 70.66 11.15 70.66 11.15Z" },
  pill: { label: "Pill", eyes: [54, 48, -14, 0.88], d: "M7.31 60.64L7.31 60.64A23 23 0 0 1 24.06 32.76L64.81 22.6A23 23 0 0 1 92.69 39.36L92.69 39.36A23 23 0 0 1 75.94 67.24L35.19 77.4A23 23 0 0 1 7.31 60.64Z" },
  seal: { label: "Seal", eyes: [50, 50, 6, 1], d: "M39.5 14a10.5 10.5 0 1 1 21 0a10.5 10.5 0 1 1 -21 0ZM57.5 18.82a10.5 10.5 0 1 1 21 0a10.5 10.5 0 1 1 -21 0ZM70.68 32a10.5 10.5 0 1 1 21 0a10.5 10.5 0 1 1 -21 0ZM75.5 50a10.5 10.5 0 1 1 21 0a10.5 10.5 0 1 1 -21 0ZM70.68 68a10.5 10.5 0 1 1 21 0a10.5 10.5 0 1 1 -21 0ZM57.5 81.18a10.5 10.5 0 1 1 21 0a10.5 10.5 0 1 1 -21 0ZM39.5 86a10.5 10.5 0 1 1 21 0a10.5 10.5 0 1 1 -21 0ZM21.5 81.18a10.5 10.5 0 1 1 21 0a10.5 10.5 0 1 1 -21 0ZM8.32 68a10.5 10.5 0 1 1 21 0a10.5 10.5 0 1 1 -21 0ZM3.5 50a10.5 10.5 0 1 1 21 0a10.5 10.5 0 1 1 -21 0ZM8.32 32a10.5 10.5 0 1 1 21 0a10.5 10.5 0 1 1 -21 0ZM21.5 18.82a10.5 10.5 0 1 1 21 0a10.5 10.5 0 1 1 -21 0ZM13 50a37 37 0 1 1 74 0a37 37 0 1 1 -74 0Z" },
  arch: { label: "Arch", eyes: [50, 54, 0, 1], d: "M74 90L26 90A10 10 0 0 1 16 80L16 57.93A30 30 0 0 1 24.19 37.33L25.28 36.17A34 34 0 0 1 74.72 36.17L75.81 37.33A30 30 0 0 1 84 57.93L84 80A10 10 0 0 1 74 90Z" },
  blob: { label: "Blob", eyes: [50, 50, -8, 1], d: "M30 14C48 4 76 8 86 26C94 40 86 52 88 66C90 84 70 94 50 92C28 90 8 80 10 58C12 40 14 24 30 14Z" },
};

// Fleet's four colours first, then six that sit with them.
export const avatarColors: Record<AvatarColor, { label: string; hex: string }> = {
  blue: { label: "Blue", hex: "#4285F4" },
  red: { label: "Red", hex: "#EA4335" },
  yellow: { label: "Yellow", hex: "#FBBC04" },
  green: { label: "Green", hex: "#34A853" },
  teal: { label: "Teal", hex: "#12B5CB" },
  purple: { label: "Purple", hex: "#A142F4" },
  pink: { label: "Pink", hex: "#E8458B" },
  orange: { label: "Orange", hex: "#FA7B17" },
  brown: { label: "Brown", hex: "#A86B3C" },
  graphite: { label: "Graphite", hex: "#5F6368" },
};

export const avatarShapes = AvatarShape.options.map((shape) => ({ shape, label: shapes[shape].label }));
export const avatarColorOptions = AvatarColor.options.map((color) => ({ color, ...avatarColors[color] }));

// Sized by className (e.g. size-6); decorative, so screen readers skip it.
export function Avatar({ avatar, className }: { avatar: BotAvatar; className?: string }) {
  const { d, eyes: [x, y, angle, scale] } = shapes[avatar.shape];
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" className={cn("block shrink-0", className)} style={{ color: avatarColors[avatar.color].hex }}>
      <path d={d} fill="currentColor" />
      <g fill="#fff" transform={`translate(${x} ${y}) rotate(${angle}) scale(${scale})`}>
        <rect x={-19} y={-12.5} width={12} height={25} rx={6} />
        <rect x={7} y={-12.5} width={12} height={25} rx={6} />
      </g>
    </svg>
  );
}
