-- READ-ONLY. Changes nothing. Run before L1.
--
-- 1) Customers that look like the same person: their numbers end in the same
--    9 digits ("+237670000000", "237670000000", "670 000 000" …).
SELECT right(regexp_replace(phone, '\D', '', 'g'), 9) AS last_9_digits,
       count(*)                                          AS accounts,
       array_agg(phone      ORDER BY created_at)         AS phones,
       array_agg(name       ORDER BY created_at)         AS names,
       array_agg(status     ORDER BY created_at)         AS statuses,
       array_agg(created_at ORDER BY created_at)         AS created,
       array_agg(id         ORDER BY created_at)         AS ids
FROM customers
WHERE phone IS NOT NULL AND regexp_replace(phone, '\D', '', 'g') <> ''
GROUP BY 1
HAVING count(*) > 1
ORDER BY accounts DESC, last_9_digits;

-- 2) Numbers not stored in the standard "+<digits>" form.
SELECT id, phone, name, status, created_at
FROM customers
WHERE phone IS NULL OR phone !~ '^\+[0-9]{6,15}$'
ORDER BY created_at;
