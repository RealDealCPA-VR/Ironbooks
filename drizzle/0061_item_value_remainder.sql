-- Average-cost sell-outs clear the inventory GL to exactly $0 (review round 4).
--
-- An average-cost item's book value is round2(quantity_on_hand x average_cost), and average_cost is
-- stored to 4 decimals, so a receipt the 4-decimal average cannot represent leaves the GL carrying
-- a few cents more or less than the book value (3000 units for $1000.00: average 0.3333, book value
-- 999.90, GL 1000.00). Every relief before the last unit telescopes on the book value, so those
-- cents used to stay on the inventory account after the item sold out.
--
-- items gains
--   value_remainder      the cents the GL carries for the item beyond its book value, recorded by
--                        the receipts that create them (bills, checks, quantity adjustments) and
--                        relieved with the last unit (QB relieves the last unit at the value that
--                        remains);
--   value_remainder_avg  the average cost the remainder belongs to. A path that re-derives the
--                        average without recording its remainder leaves the stamp behind, which
--                        makes the remainder void (never relieved) instead of wrong.
ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "value_remainder" numeric(15, 2) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "value_remainder_avg" numeric(15, 4);
