-- 009: payment by bank QR at the till.
--
-- * settings.pay_qr         the text inside the shop's own bank QR (LAO QR /
--                           EMVCo), saved by the owner from a photo of it.
-- * settings.pay_qr_amount  write the sale's total into that QR (default on).
--                           The owner turns it off if their bank's app refuses
--                           a QR with an amount in it; the customer then types it.
--
-- Members can read settings already, so every till can show the QR. Only the
-- owner changes it (settings_update in 001 is owner-only): a cashier must not
-- be able to swap in their own account's QR.

alter table public.settings
  add column pay_qr        text check (pay_qr is null or length(pay_qr) between 1 and 512),
  add column pay_qr_amount boolean not null default true;
grant update (pay_qr, pay_qr_amount) on public.settings to authenticated;
