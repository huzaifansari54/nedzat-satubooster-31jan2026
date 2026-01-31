module.exports = {
  apps: [
    {
      name: "SAAS-NEDZAT-MAIN",
      script: "index.js",
      cwd: "/home/ubuntu/SAAS-NEDZAT-MAIN",
      env: {
        SMTP_HOST: "smtp.gmail.com",
        SMTP_PORT: "465",
        SMTP_SECURE: "1",
        SMTP_USER: "assylzhan21@gmail.com",
        SMTP_PASS: "fhgq hfzu oyub dyux",
        SMTP_FROM: "SatuBooster <assylzhan21@gmail.com>",
        SMTP_TLS_REJECT_UNAUTHORIZED: "1",
        VERIFY_RESEND_COOLDOWN_MS: "60000"
      }
    }
  ]
}
