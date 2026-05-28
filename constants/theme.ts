export const theme = {
  colors: {
    primary: '#9B59D0',       // 소프트 퍼플
    primaryLight: '#C084F5',  // 브라이트 라벤더
    primaryDark: '#6B3FA0',   // 미디엄 퍼플
    background: '#E8D5F5',    // 배경색 (폴백용)
    surface: 'rgba(255, 255, 255, 0.45)', // 밝은 반투명 화이트 글래스
    surfaceSolid: '#D8C2EC',  // 라이트 라벤더 (단색 표면용)
    accent: '#D946A8',        // 소프트 매젠타
    success: '#00E676',
    warning: '#FFB300',
    error: '#FF5252',
    textPrimary: '#2D1B4E',   // 다크 퍼플
    textSecondary: '#7B6B8D', // 뮤트 퍼플
    glassBorder: 'rgba(255, 255, 255, 0.5)',
  },
  gradients: {
    background: ['#E8D5F5', '#C4A6E0', '#A78BCA'],
    button: ['#9B59D0', '#D946A8'],
  },
  spacing: {
    xs: 4,
    s: 8,
    m: 16,
    l: 24,
    xl: 32,
    xxl: 48,
  },
  borderRadius: {
    s: 8,
    m: 16,
    l: 24,
    round: 9999,
  },
  typography: {
    h1: { fontSize: 32, fontWeight: '700' as const },
    h2: { fontSize: 24, fontWeight: '700' as const },
    h3: { fontSize: 20, fontWeight: '600' as const },
    body1: { fontSize: 16, fontWeight: '400' as const },
    body2: { fontSize: 14, fontWeight: '400' as const },
    caption: { fontSize: 12, fontWeight: '400' as const },
  }
} as const;

export type Theme = typeof theme;
