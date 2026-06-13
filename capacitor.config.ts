import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Native mobile app shell (iOS / Android) built with Capacitor.
 *
 * IMPORTANT: webDir is the lightweight app build (`dist-app`), produced by
 * `npm run build:app`. It must NOT point at `dist/` (the web/Vercel build).
 * Run `npm run cap:sync` to rebuild dist-app and copy it into the native apps.
 */
const config: CapacitorConfig = {
  appId: 'com.kavakgames.torble',
  appName: 'Torble',
  webDir: 'dist-app',
  // Match the app's dark theme so there is no white flash on launch.
  backgroundColor: '#0d1117',
  ios: {
    // viewport-fit=cover is already set in index.html; let content draw under
    // the status bar / home indicator for a full-bleed app feel.
    contentInset: 'never',
    backgroundColor: '#0d1117',
  },
  android: {
    backgroundColor: '#0d1117',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 600,
      launchAutoHide: true,
      backgroundColor: '#0d1117',
      showSpinner: false,
      androidScaleType: 'CENTER_CROP',
      splashFullScreen: true,
      splashImmersive: true,
    },
    Keyboard: {
      // Resize the native webview frame when the keyboard opens (default,
      // safest behavior for a standard React app).
      resize: 'native',
      resizeOnFullScreen: true,
    },
  },
};

export default config;
