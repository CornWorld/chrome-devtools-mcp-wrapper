/**
 * 通用浏览器反检测参数和脚本。
 * 从 yc_crawler/src/core/fingerprints.mjs 提取的通用子集，
 * 不包含业务相关的指纹池/预设系统。
 */

/**
 * Chrome 启动参数 — 隐藏自动化标记 + 稳定性优化。
 * 与 Playwright launch args 和 CDP 直连两种模式都兼容。
 */
export const ANTI_DETECT_ARGS = [
  // 隐藏自动化标记
  '--disable-blink-features=AutomationControlled',
  '--disable-infobars',

  // 稳定性
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-component-extensions-with-background-pages',
  '--disable-default-apps',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  '--disable-sync',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--disable-session-crashed-bubble',
  '--disable-search-engine-choice-screen',
  '--disable-notifications',
  '--noerrdialogs',
  '--test-type',

  // macOS: 禁用 Keychain 访问弹窗
  '--use-mock-keychain',
  '--password-store=basic',

  // 禁用密码管理器和保存凭据提示
  '--disable-credentials-backends',
  '--disable-password-generation',
  '--disable-save-password-bubble',
  '--credentials-enable-account-storage=false',

  // 禁用各种不需要的功能
  '--disable-autofill',
  '--disable-ask-to-save-passwords',
  '--disable-translate-new-ux',
  '--disable-features=PasswordLeakDetection,PasswordSignin,PasswordManagerOnboarding,PasswordCheck,AutofillServerCommunication,Translate,ChromeWhatsNewUI,SafetyCheck,SafetyHub,SigninInterceptBubble,DesktopPWAsLinkCapturing,ImprovedCookieControls,LazyFrameLoading,GlobalMediaControls',
  '--no-service-autorun',

  // 渲染
  '--force-color-profile=srgb',
  '--metrics-recording-only',
  '--safebrowsing-disable-auto-update',
  '--ignore-certificate-errors',
  '--allow-running-insecure-content',
  '--enable-features=NetworkService,NetworkServiceInProcess',
  '--hide-scrollbars',
  '--mute-audio',
];

/**
 * 页面级反检测脚本 — 用作 `--init-script` 或 CDP `Page.addScriptToEvaluateOnNewDocument`。
 * 覆盖常见自动化检测点。
 */
export const ANTI_DETECT_INIT_SCRIPT = `(function() {
  // 1. 隐藏 navigator.webdriver
  Object.defineProperty(navigator, 'webdriver', { get: () => false });

  // 2. 伪装 chrome 对象
  if (!window.chrome) {
    window.chrome = { runtime: {}, loadTimes() {}, csi() {}, app: {} };
  }

  // 3. 伪装 permissions
  const origQuery = window.navigator.permissions?.query;
  if (origQuery) {
    window.navigator.permissions.query = (p) =>
      p.name === 'notifications'
        ? Promise.resolve({ state: 'prompt' })
        : origQuery(p);
  }

  // 4. 伪装 plugins
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'Chrome PDF Plugin', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
      { name: 'Chrome PDF Viewer', description: '', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
      { name: 'Native Client', description: '', filename: 'internal-nacl-plugin' },
    ],
  });

  // 5. 伪装 languages
  Object.defineProperty(navigator, 'languages', {
    get: () => ['zh-CN', 'zh', 'en-US', 'en'],
  });

  // 6. 删除原型链上的 webdriver
  delete navigator.__proto__.webdriver;

  // 7. window outer 尺寸
  Object.defineProperty(window, 'outerWidth', { get: () => window.screen.width });
  Object.defineProperty(window, 'outerHeight', { get: () => window.screen.height });

  // 8. Connection rtt
  if (navigator.connection) {
    Object.defineProperty(navigator.connection, 'rtt', { get: () => 100 });
  }

  // 9. WebGL vendor/renderer（通用值）
  const hookGL = (Proto) => {
    const orig = Proto.prototype.getParameter;
    Proto.prototype.getParameter = function(p) {
      if (p === 37445) return 'Google Inc. (Intel)';
      if (p === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.1)';
      return orig.call(this, p);
    };
  };
  hookGL(WebGLRenderingContext);
  if (typeof WebGL2RenderingContext !== 'undefined') hookGL(WebGL2RenderingContext);

  // 10. Canvas 指纹噪声 — toDataURL / toBlob 添加微量像素偏移
  (function() {
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const origToBlob = HTMLCanvasElement.prototype.toBlob;

    function addNoise(canvas) {
      try {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const w = canvas.width;
        const h = canvas.height;
        if (w === 0 || h === 0) return;
        const imageData = ctx.getImageData(0, 0, w, h);
        const data = imageData.data;
        // 仅修改少量像素，避免视觉影响
        for (let i = 0; i < data.length; i += 4 * 47) {
          data[i] = data[i] ^ 1;     // R 通道最低位翻转
        }
        ctx.putImageData(imageData, 0, 0);
      } catch { /* SecurityError on cross-origin, ignore */ }
    }

    HTMLCanvasElement.prototype.toDataURL = function(...args) {
      addNoise(this);
      return origToDataURL.apply(this, args);
    };
    HTMLCanvasElement.prototype.toBlob = function(...args) {
      addNoise(this);
      return origToBlob.apply(this, args);
    };
  })();

  // 11. navigator.deviceMemory 伪装
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });

  // 12. navigator.hardwareConcurrency 伪装
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });

  // 13. navigator.maxTouchPoints 伪装（桌面浏览器）
  Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0, configurable: true });

  // 14. screen 尺寸一致性
  const screenProps = {
    width: { get: () => 1920 },
    height: { get: () => 1080 },
    availWidth: { get: () => 1920 },
    availHeight: { get: () => 1080 },
    colorDepth: { get: () => 24 },
    pixelDepth: { get: () => 24 },
  };
  for (const [prop, desc] of Object.entries(screenProps)) {
    Object.defineProperty(screen, prop, { ...desc, configurable: true });
  }
})();`;
