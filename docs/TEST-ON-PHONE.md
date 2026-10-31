# Test it from your phone (no computer needed)

This puts a **test version** online using two free accounts: Supabase (database and sign-in) and
Vercel (the website). Posting is faked, so nothing reaches your real social accounts and nothing
costs money. About 30 minutes.

What works in the test version: sign-in, brands, (fake) connected accounts, drafts, the approval
queue, scheduling, and connecting Claude or ChatGPT to create drafts and approve them with the card.

What does not work yet: scheduled posts stay "scheduled" (publishing runs on the Railway worker),
video uploads and clips (need Cloudflare R2 and the worker), and billing (needs Stripe). Those come
in the full setup in [DEPLOY.md](DEPLOY.md).

## 1. Supabase (database and sign-in), about 10 minutes

1. Go to **supabase.com**, tap **Start your project**, and sign in with GitHub.
2. Create a new project. Name it `clipcast-test`. For the database password, use only letters and
   numbers (special characters break the connection string). **Save the password in your notes.**
   Pick the region closest to you. Wait until the project is ready.
3. Tap **Connect** at the top of the project page. Choose **Session pooler** and copy the
   connection string. It looks like
   `postgresql://postgres.abcd:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:5432/postgres`.
   In your notes, replace `[YOUR-PASSWORD]` with your password and add `?sslmode=require` to the
   end. This is your **DATABASE_URL**.
4. Open **Project Settings → API Keys** (or **Data API**). Copy the **Project URL** (your
   **SUPABASE_URL**) and the **anon** / **publishable** key (your **SUPABASE_ANON_KEY**).

## 2. Vercel (the website), about 10 minutes

1. Go to **vercel.com**, sign up with GitHub, then **Add New → Project** and import the `App-`
   repository (allow Vercel to see it if asked).
2. Set **Root Directory** to `apps/web`. Leave the build settings as they are; the repo's
   `vercel.json` handles them.
3. Open **Environment Variables**. You can paste this whole block into the first name field and
   Vercel splits it into separate variables. Fill in your values:

   ```
   APP_ENV=preview
   DATABASE_URL=your Supabase session pooler string from step 1.3
   RUN_MIGRATIONS=1
   SUPABASE_URL=your Project URL
   SUPABASE_ANON_KEY=your anon or publishable key
   TOKEN_ENCRYPTION_KEYS=generated value
   SESSION_SECRET=generated value
   CRON_SECRET=generated value
   POSTING_PROVIDER=fake
   FAKE_POSTING_CONNECT_ALL=1
   STORAGE_DRIVER=memory
   TRANSCRIPTION_PROVIDER=fake
   ```

   The three generated values are random secrets. Claude can generate them for you, or on a
   computer run `pnpm secrets`. Use new ones for the real launch.
4. Tap **Deploy** and wait 3 to 5 minutes. The build also creates the database tables
   (`RUN_MIGRATIONS=1`). When it finishes, copy your site address, for example
   `https://app-abc.vercel.app`.

## 3. Let Supabase send sign-in links to your site

In Supabase, open **Authentication → URL Configuration**:

- **Site URL**: your Vercel address.
- **Redirect URLs**: add your Vercel address followed by `/**`, for example
  `https://app-abc.vercel.app/**`.

Supabase's built-in email only sends to members of your Supabase team, so sign in with the email
you used for Supabase.

## 4. Try the website

1. Open your Vercel address, tap **Sign in**, enter your email, and open the link from your inbox
   on the same phone.
2. Create a brand (**Brands**), then **Accounts → Connect accounts**. In the test version every
   platform shows as connected.
3. Look around: Approvals, Calendar, Voice, Analytics, Connect.

## 5. Connect Claude

1. In Claude (the app or claude.ai), open **Settings → Connectors → Add custom connector**. Custom
   connectors depend on your Claude plan.
2. Name it `Clipcast` and use your Vercel address followed by `/api/mcp`, for example
   `https://app-abc.vercel.app/api/mcp`.
3. Tap **Connect**. A page from your site asks you to sign in (if needed) and **Allow** access.
4. In a new chat, try:
   - "Using Clipcast, list my brands and accounts."
   - "Write a LinkedIn post and an X post about why short videos beat long ones, save them as a
     draft, and show me the approval card."
   - Tap **Approve** on the card, then: "Schedule it for tomorrow at 9am."
   - "What's the status of my posts?"
5. Check the website: the draft is in **Approvals** (or approved) and the post is on the
   **Calendar** as scheduled.

## 6. Connect ChatGPT (optional)

ChatGPT's custom connectors need developer mode, which is set up on chatgpt.com (on a phone, use
the browser and request the desktop site). Open **Settings → Apps & Connectors → Advanced settings**,
turn on **Developer mode**, then create a connector with the same `/api/mcp` address and repeat
the chat tests from step 5. This needs a paid ChatGPT plan.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| Vercel build fails at "migration failed" | DATABASE_URL is wrong: check the password, that you used the **Session pooler** string, and `?sslmode=require` at the end. Then redeploy. |
| Vercel build fails with "Invalid configuration" | A variable is missing or misspelled; the message names it. |
| No sign-in email arrives | Use the email of your Supabase account, wait a minute, check spam. Supabase's built-in email is limited to a few emails per hour. |
| Sign-in link opens an error page | Redirect URLs in step 3 must include your Vercel address followed by `/**`. |
| Claude says it can't connect | Check that the address ends in `/api/mcp`, and that the site opens in your browser. |

Send Claude a screenshot of any error and it can tell you what to change.
