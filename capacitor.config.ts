import type { CapacitorConfig } from "@capacitor/cli";

// Mobile shell: shows a one-time server address screen (mobile/index.html),
// then redirects into your running iTask Bot server (same Wi-Fi/LAN IP or
// a deployed https URL — e.g. http://192.168.1.10:3000 or https://bot.example.com)
const config: CapacitorConfig = {
  appId: "vn.itask.bot",
  appName: "iTask Bot",
  webDir: "mobile",
  server: {
    // Allow navigation to whatever server address the user enters.
    allowNavigation: ["*"],
    cleartext: true, // LAN http:// — remove for production https-only
  },
};

export default config;
