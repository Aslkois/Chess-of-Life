/** Original stroke icon set. Icons are decorative unless given a label by the caller. */
type P = { size?: number };
const S = ({ size = 20, children }: { size?: number; children: React.ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);
export const IconHome = ({ size }: P) => <S size={size}><path d="M3.5 11 12 4l8.5 7" /><path d="M5.5 9.5V20h13V9.5" /><path d="M10 20v-5h4v5" /></S>;
/** Game review: a magnifier over a board corner */
export const IconReview = ({ size }: P) => <S size={size}><path d="M3 3h8v8H3z" /><path d="M3 7h4V3M7 7v4" /><circle cx="15.5" cy="15.5" r="4.5" /><path d="m19 19 2.5 2.5" /></S>;
/** Reconstruct: a board with a pencil */
export const IconReconstruct = ({ size }: P) => <S size={size}><path d="M3 3h12v12H3z" /><path d="M3 9h12M9 3v12" /><path d="m14.5 21 6.5-6.5-2-2-6.5 6.5-.5 2.5z" /></S>;
export const IconUpload = ({ size }: P) => <S size={size}><path d="M12 15V4" /><path d="m7.5 8.5 4.5-4.5 4.5 4.5" /><path d="M4 15v4.5h16V15" /></S>;
export const IconFile = ({ size }: P) => <S size={size}><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 16h6" /></S>;
export const IconCoach = ({ size }: P) => <S size={size}><path d="M12 3.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7z" /><path d="M5 20.5c.6-3.9 3.4-6.5 7-6.5s6.4 2.6 7 6.5" /><path d="M17.5 4.5 20 3M18.5 8H21" /></S>;
export const IconRanked = ({ size }: P) => <S size={size}><path d="M14 3h7v7L9.5 21.5l-7-7z" /><path d="m6 13 5 5" /><path d="m3 21 2.5-2.5" /></S>;
export const IconLibrary = ({ size }: P) => <S size={size}><path d="M4 4h4v16H4zM10 4h4v16h-4z" /><path d="m16 5.5 3.5-1 3 14.5-3.5 1z" /></S>;
export const IconProgress = ({ size }: P) => <S size={size}><path d="M3 20.5h18" /><path d="M6 17v-5M11 17V7M16 17v-8M21 17V4" /></S>;
export const IconSettings = ({ size }: P) => <S size={size}><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></S>;
export const IconBranch = ({ size }: P) => <S size={size}><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 7v10" /><path d="M18 10c0 4-6 3-11.2 7.6" /></S>;
export const IconFlip = ({ size }: P) => <S size={size}><path d="M7 4v16" /><path d="m4 17 3 3 3-3" /><path d="M17 20V4" /><path d="m14 7 3-3 3 3" /></S>;
export const IconFirst = ({ size }: P) => <S size={size}><path d="M6 5v14" /><path d="m18 6-6 6 6 6" /></S>;
export const IconPrev = ({ size }: P) => <S size={size}><path d="m15 6-6 6 6 6" /></S>;
export const IconNext = ({ size }: P) => <S size={size}><path d="m9 6 6 6-6 6" /></S>;
export const IconLast = ({ size }: P) => <S size={size}><path d="M18 5v14" /><path d="m6 6 6 6-6 6" /></S>;
export const IconClose = ({ size }: P) => <S size={size}><path d="M6 6l12 12M18 6 6 18" /></S>;
export const IconTrash = ({ size }: P) => <S size={size}><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6.5 7 7.5 20h9l1-13" /></S>;
export const IconLock = ({ size }: P) => <S size={size}><path d="M6 11h12v9.5H6z" /><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3" /></S>;
export const IconMenu = ({ size }: P) => <S size={size}><path d="M4 7h16M4 12h16M4 17h16" /></S>;
export const IconFlag = ({ size }: P) => <S size={size}><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></S>;
export const IconHandshake = ({ size }: P) => <S size={size}><path d="M2.5 11.5 6 8l4 1.5 2-1.5 3 .5 3.5-1.5L21.5 11" /><path d="m6 8 6.5 7.5a1.5 1.5 0 0 0 2.2-2L10 9.5" /><path d="m9 15 1.5 1.5M11.5 17l1 1" /></S>;
export const IconSearch = ({ size }: P) => <S size={size}><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></S>;
export const IconDownload = ({ size }: P) => <S size={size}><path d="M12 4v11" /><path d="m7.5 10.5 4.5 4.5 4.5-4.5" /><path d="M4 19.5h16" /></S>;
export const IconKeyboard = ({ size }: P) => <S size={size}><path d="M3 6h18v12H3z" /><path d="M6.5 9.5h.01M10 9.5h.01M13.5 9.5h.01M17 9.5h.01M7 14.5h10" /></S>;
export const IconBulb = ({ size }: P) => <S size={size}><path d="M9 18h6M10 21h4" /><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z" /></S>;
export const IconUndo = ({ size }: P) => <S size={size}><path d="M9 7 4.5 11.5 9 16" /><path d="M5 11.5h9.5a5 5 0 0 1 0 10H11" /></S>;
export const IconPlay = ({ size }: P) => <S size={size}><path d="M7 4.5v15l12-7.5z" /></S>;
export const IconCpu = ({ size }: P) => <S size={size}><path d="M7 7h10v10H7z" /><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" /></S>;
export const IconEye = ({ size }: P) => <S size={size}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></S>;
export const IconSort = ({ size }: P) => <S size={size}><path d="m8 9 4-4 4 4M8 15l4 4 4-4" /></S>;
export const IconStar = ({ size }: P) => <S size={size}><path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.9z" /></S>;
export const IconBook = ({ size }: P) => <S size={size}><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" /><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5" /><path d="M8 7.5h8M8 11h5" /></S>;
export const IconAlert = ({ size }: P) => <S size={size}><path d="M12 4 2.5 20h19z" /><path d="M12 10v4.5M12 17.5h.01" /></S>;
