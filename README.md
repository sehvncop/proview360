# PropView360 — Deploy Guide

## 1. Supabase Setup (do this first)

Go to: https://supabase.com → your project → SQL Editor → New Query

Paste contents of `SUPABASE_SETUP.sql` → Run

Then go to: Storage → New Bucket
- Name: `panoramas`
- Public bucket: ✅ YES

## 2. Deploy to Vercel

```bash
# Install Vercel CLI
npm i -g vercel

# Inside this folder
vercel

# Follow prompts, then add env vars:
vercel env add NEXT_PUBLIC_SUPABASE_URL
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY
vercel env add SUPABASE_SERVICE_ROLE_KEY

# Deploy production
vercel --prod
```

OR drag-drop this folder to vercel.com → add env vars in dashboard.

## 3. Env vars to add in Vercel dashboard

```
NEXT_PUBLIC_SUPABASE_URL=https://rdstckwjlktzpufbatqg.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

## 4. Test flow

1. Go to `yoursite.vercel.app/scan` on phone
2. Allow camera + gyro
3. Follow dots → capture all shots
4. Fill property details → Publish
5. Get redirected to `yoursite.vercel.app/view/[id]`
6. Share that URL with buyer → they see 360° tour

## Pages

- `/` — listings index
- `/scan` — dealer guided capture + upload
- `/view/[id]` — buyer 360° viewer
