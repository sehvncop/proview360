-- Run this in Supabase → SQL Editor → New Query → Run

CREATE TABLE IF NOT EXISTS listings (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  title text NOT NULL,
  address text,
  price text,
  bedrooms int,
  bathrooms int,
  area_sqft int,
  status text DEFAULT 'for_sale',
  shots jsonb,
  cover_url text,
  dealer_name text,
  dealer_phone text
);

-- Allow public read
ALTER TABLE listings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read listings"
  ON listings FOR SELECT
  USING (true);

CREATE POLICY "Anyone can insert listings"
  ON listings FOR INSERT
  WITH CHECK (true);
