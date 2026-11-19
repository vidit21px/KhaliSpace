# KhaliSpace

Shippers post loads, drivers post spare truck space, both chat in-app. React + Firebase (Auth, Firestore, Hosting). Free tier only.

## One-time setup (about 20 minutes)

1. **Install Node.js** (LTS) from nodejs.org.
2. **Create a Firebase project** at console.firebase.google.com (name it e.g. khalispace-odisha). Skip Google Analytics.
3. In the project turn on:
   - Build → Authentication → Get started → Sign-in method → **Google** → Enable
   - Build → Firestore Database → Create database (any location, e.g. asia-south1 Mumbai; start in production mode, our rules replace it)
   - Build → Hosting → Get started
4. **Register a web app**: Project settings (gear icon) → Your apps → `</>` Web → register. Copy the four values shown (apiKey, authDomain, projectId, appId).
5. In this folder, copy `.env.example` to `.env` and paste those four values in.
6. Install the Firebase CLI and log in:
   ```
   npm install -g firebase-tools
   firebase login
   firebase use --add      # pick your project
   ```

## Run it on your computer
```
npm install
npm run dev
```
Open the link it prints, sign in with Google, set up your profile, post a listing.

## Go live
```
npm run build
firebase deploy
```
Your site appears at https://YOUR-PROJECT.web.app

## Custom domain
Firebase Console → Hosting → Add custom domain, follow the DNS steps.
Then: Authentication → Settings → Authorized domains → add your domain (otherwise Google sign-in fails there).

## Notes
- Phone numbers and ID numbers live only in `users/{uid}`, readable only by that user. They are never in listings.
- Drivers’ KYC is "submitted", not verified. Check IDs yourself in the Firestore console before trusting anyone; real verification (DigiLocker / IDfy) is a later upgrade.
- Chat uses Firestore live listeners, free tier is plenty for a pilot.
- Free-tier quota is 50k reads / 20k writes per day; if you outgrow it you’ll see errors in the app.
