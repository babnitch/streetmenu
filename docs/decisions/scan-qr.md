# QR codes are links (Prompt Q)

- Every event ticket, order and voucher has a QR that is a link:
  `https://<site>/scan/<token>`. The token is `HMAC-SHA256(SCAN_TOKEN_SECRET,
  "<kind>:<id>:<version>")`, base64url, 22 characters (128 bits). Only its
  SHA-256 is stored (`scan_tokens`), so the database alone can't rebuild a QR;
  the server recomputes the token whenever it shows the QR again.
- Opening the link never changes anything (WhatsApp and browsers pre-open
  links). Only the button on the scan page (a POST) checks in / hands over /
  redeems, atomically, once.
- The short code (#AB12) stays as the fallback the customer reads out.

## SCAN_TOKEN_SECRET — never rotate casually

Set in Vercel (Production + Preview) and `.env.local`; never shown or
committed. **Changing it invalidates every QR already shown or sent**
(tickets in people's WhatsApp, printed vouchers): they would all open the
"not found" page. Rotate only after a real leak, knowingly. To revoke ONE
QR, raise that item's version in `scan_tokens` instead.
