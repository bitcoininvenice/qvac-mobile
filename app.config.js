// Configurazione di Expo: app.json + i dati del tuo account, che non stanno nella repo.
// L'Apple Team ID (per firmare l'app iOS) va in .env.local, ignorato da git:
//   APPLE_TEAM_ID=XXXXXXXXXX
// Lo trovi in Xcode → Settings → Accounts, oppure su developer.apple.com → Membership.
module.exports = ({ config }) => ({
  ...config,
  ios: {
    ...config.ios,
    ...(process.env.APPLE_TEAM_ID ? { appleTeamId: process.env.APPLE_TEAM_ID } : {}),
  },
});
