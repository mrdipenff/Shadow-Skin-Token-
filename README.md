# Shadow Skin Ticket Backend

This backend connects the app to the **existing** daily code endpoint:

- Website: https://shadow-skin-oficial.vercel.app/
- Existing code API: https://shadow-skin-oficial.vercel.app/api/key

It does not generate a new daily code. On every redemption, the backend fetches the current `password` from the existing API and verifies the submitted code.

## Rules implemented

- One current website code can be redeemed once per device per India calendar day.
- A successful redemption adds 1 ticket.
- Tickets do not expire.
- Clicking Get Tickets starts a 24-hour cooldown and returns the existing website URL.
- A successful image submission consumes 1 ticket and starts a 24-hour submission cooldown.
- All cooldowns and ticket balances are stored in PostgreSQL, not SharedPreferences.

## Deploy

1. Create a PostgreSQL database (for example, Render PostgreSQL).
2. Create a Node web service from this folder/repository.
3. Build command: `npm install`
4. Start command: `npm start`
5. Environment variables:
   - `DATABASE_URL` = PostgreSQL connection string
   - `PGSSL` = leave unset for hosted PostgreSQL; set to `disable` only for local non-SSL DB
6. Run `schema.sql` once against the database.
7. Confirm `https://YOUR-SERVICE/health` returns `{"ok":true}`.

## API

All POST bodies use JSON.

### POST /api/state
`{"deviceId":"stable-device-id"}`

### POST /api/get-tickets
`{"deviceId":"stable-device-id"}`

Starts the 24-hour Get Tickets cooldown. Returns `websiteUrl`.

### POST /api/redeem
`{"deviceId":"stable-device-id","code":"daily-code"}`

Fetches the current code from the existing website API and awards one ticket if this device has not redeemed today.

### POST /api/consume-ticket
`{"deviceId":"stable-device-id"}`

Call only after Telegram reports a successful image upload. Deducts one ticket and starts the 24-hour submission cooldown.

## Important security limitation

This starter identifies a device using an Android ID supplied by the app. Android ID normally survives app Clear Data and reinstall on the same Android user/device, but can change after factory reset/device changes and can be spoofed on compromised devices. Because the app currently has no authenticated user account, this is not strong identity proof. For stronger anti-abuse protection, add real account authentication (or Play Integrity verification) before public release.

The existing website's daily code is shared by everyone. This backend correctly allows each device one redemption per India calendar day; it does **not** mark the shared code globally as consumed.

## Android device ID

Use `Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID)` as the device ID. Do not use the daily `saved_key` as the device ID because all users share that code.

Do not put a PostgreSQL password or private server secret in the Android APK.
