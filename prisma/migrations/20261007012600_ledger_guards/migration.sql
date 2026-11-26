-- ═══════════════════════════════════════════════════════════════════
--  VIJAYA STORES — LEDGER GUARDS
--
--  Applied by `prisma migrate deploy` on every start, so an empty database can never run without them.
--  The app also refuses to start if any trigger below is missing or disabled (src/server/guards.ts).
--
--  Why here and not only in the tool layer: the assistant, a bug, or a person in the database console can all be
--  wrong. The tool layer is the first line of defence; this is the one that cannot be argued with.
--
--  Every RAISE starts with a CODE: so src/server/errors.ts can turn it into plain words. Enums are compared with
--  plain string literals ('ISSUE'), never ::casts.
--
--  Source: reference/inventory_guards.sql, tightened where BUSINESS_FLOW.md already states the rule:
--   * the database, not the caller, decides the rate of every OUT movement, RETURN, COUNT_ADJUSTMENT and OPENING;
--   * a count line posts exactly once, with exactly its quantity and direction;
--   * RECEIPT / REJECT_RETURN need a goods receipt line, SCRAP_SALE a scrap sale, REVERSAL the movement it reverses
--     (BUSINESS_FLOW §4 "Needs" column), and a reversal mirrors its original;
--   * count lines freeze when the count goes to the owner; an approved count is final;
--   * TRUNCATE is blocked on the ledger (BUSINESS_FLOW §4 "never truncated");
--   * artifact versions are immutable (ARTIFACTS §8).
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. Quantities and rates ────────────────────────────────────────
ALTER TABLE stock_movements
  ADD CONSTRAINT chk_movement_qty_positive  CHECK (quantity > 0),
  ADD CONSTRAINT chk_movement_rate_positive CHECK (rate >= 0);

ALTER TABLE stock_balances
  ADD CONSTRAINT chk_balance_rate_positive CHECK ("averageRate" >= 0);

ALTER TABLE goods_receipt_lines
  ADD CONSTRAINT chk_grn_split CHECK ("acceptedQty" + "rejectedQty" = "receivedQty"),
  ADD CONSTRAINT chk_grn_qty_positive CHECK ("receivedQty" > 0 AND "acceptedQty" >= 0 AND "rejectedQty" >= 0);

ALTER TABLE purchase_order_lines
  ADD CONSTRAINT chk_po_line_positive CHECK (quantity > 0 AND rate >= 0 AND "receivedQty" >= 0);

ALTER TABLE job_bom_lines
  ADD CONSTRAINT chk_bom_qty_positive CHECK ("qtyPerPiece" > 0 AND "requiredQty" > 0);

ALTER TABLE jobs
  ADD CONSTRAINT chk_job_qty_positive CHECK (quantity > 0);

ALTER TABLE scrap_sales
  ADD CONSTRAINT chk_scrap_sale_positive CHECK (quantity > 0 AND rate >= 0 AND amount >= 0);

ALTER TABLE materials
  ADD CONSTRAINT chk_material_minimum CHECK ("minimumLevel" IS NULL OR "minimumLevel" >= 0),
  ADD CONSTRAINT chk_standing_has_minimum CHECK ("stockType" <> 'STANDING' OR "minimumLevel" IS NOT NULL),
  ADD CONSTRAINT chk_material_gst CHECK ("gstRate" IS NULL OR ("gstRate" >= 0 AND "gstRate" <= 100));

ALTER TABLE parties
  ADD CONSTRAINT chk_party_has_type CHECK ("isSupplier" OR "isCustomer"),
  ADD CONSTRAINT chk_party_gstin CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$');

ALTER TABLE users
  ADD CONSTRAINT chk_user_email_lower CHECK (email = lower(email));

ALTER TABLE number_series
  ADD CONSTRAINT chk_series_number CHECK ("lastNumber" >= 0);

-- ── 2. Count lines ─────────────────────────────────────────────────
ALTER TABLE stock_count_lines
  ADD CONSTRAINT chk_count_difference CHECK ("differenceQty" = "countedQty" - "systemQty"),
  ADD CONSTRAINT chk_count_rate_positive CHECK ("unitRate" IS NULL OR "unitRate" > 0),
  ADD CONSTRAINT chk_count_qty_not_negative CHECK ("countedQty" IS NULL OR "countedQty" >= 0),
  ADD CONSTRAINT chk_count_reason CHECK ("reasonCode" IS NULL
    OR "reasonCode" IN ('SPILLAGE','EXTRA_WASTAGE','MISSING','ENTRY_ERROR','UNEXPLAINED'));

-- ── 3. What each movement type must point at (BUSINESS_FLOW §4) ────
ALTER TABLE stock_movements
  ADD CONSTRAINT chk_movement_direction CHECK (
    (type IN ('OPENING','RECEIPT','RETURN','SCRAP_IN') AND direction = 'IN')
    OR (type IN ('ISSUE','REJECT_RETURN','SCRAP_SALE') AND direction = 'OUT')
    OR (type IN ('COUNT_ADJUSTMENT','REVERSAL'))
  ),
  ADD CONSTRAINT chk_issue_has_job CHECK (type NOT IN ('ISSUE','RETURN') OR "jobId" IS NOT NULL),
  ADD CONSTRAINT chk_adjustment_has_count CHECK (type <> 'COUNT_ADJUSTMENT' OR "stockCountLineId" IS NOT NULL),
  ADD CONSTRAINT chk_opening_has_count CHECK (type <> 'OPENING' OR "stockCountLineId" IS NOT NULL),
  ADD CONSTRAINT chk_receipt_has_grn CHECK (type NOT IN ('RECEIPT','REJECT_RETURN') OR "grnLineId" IS NOT NULL),
  ADD CONSTRAINT chk_sale_has_scrap_sale CHECK (type <> 'SCRAP_SALE' OR "scrapSaleId" IS NOT NULL),
  ADD CONSTRAINT chk_reversal_has_original CHECK ((type = 'REVERSAL') = ("reversalOfId" IS NOT NULL));

-- A count line posts once, a receipt line posts each of its movements once.
CREATE UNIQUE INDEX uq_movement_count_line ON stock_movements ("stockCountLineId") WHERE "stockCountLineId" IS NOT NULL;
CREATE UNIQUE INDEX uq_movement_grn_line_type ON stock_movements ("grnLineId", type) WHERE "grnLineId" IS NOT NULL;

-- ── 4. Count adjustments and the opening count ─────────────────────
CREATE OR REPLACE FUNCTION guard_count_adjustment() RETURNS TRIGGER AS $$
DECLARE
  v_status     TEXT;
  v_is_opening BOOLEAN;
  v_material   TEXT;
  v_counted    NUMERIC;
  v_diff       NUMERIC;
BEGIN
  IF NEW.type IN ('COUNT_ADJUSTMENT', 'OPENING') THEN
    SELECT sc.status, sc."isOpening", scl."materialId", scl."countedQty", scl."differenceQty"
      INTO v_status, v_is_opening, v_material, v_counted, v_diff
    FROM stock_count_lines scl
    JOIN stock_counts sc ON sc.id = scl."stockCountId"
    WHERE scl.id = NEW."stockCountLineId";

    IF v_status IS DISTINCT FROM 'APPROVED' THEN
      RAISE EXCEPTION 'COUNT_NOT_APPROVED: stock can only change from a count the owner approved (count is %)', COALESCE(v_status, 'MISSING');
    END IF;
    IF v_material IS DISTINCT FROM NEW."materialId" THEN
      RAISE EXCEPTION 'COUNT_LINE_MISMATCH: the movement is for a different material than the count line';
    END IF;

    IF NEW.type = 'OPENING' THEN
      IF v_is_opening IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'OPENING_ONLY_FROM_OPENING_COUNT: OPENING movements can only come from the opening count';
      END IF;
      IF NEW.quantity IS DISTINCT FROM v_counted THEN
        RAISE EXCEPTION 'COUNT_LINE_MISMATCH: an opening movement must carry exactly the counted quantity';
      END IF;
    ELSE
      IF v_is_opening THEN
        RAISE EXCEPTION 'OPENING_COUNT_POSTS_OPENING: the opening count posts OPENING movements, not COUNT_ADJUSTMENT';
      END IF;
      IF v_diff IS NULL OR v_diff = 0
         OR NEW.quantity <> ABS(v_diff)
         OR NEW.direction <> (CASE WHEN v_diff > 0 THEN 'IN' ELSE 'OUT' END)::"MovementDirection" THEN
        RAISE EXCEPTION 'COUNT_LINE_MISMATCH: an adjustment must carry exactly the counted difference';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_guard_count_adjustment
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION guard_count_adjustment();

-- ── 5. A reversal mirrors the movement it reverses ─────────────────
CREATE OR REPLACE FUNCTION guard_reversal() RETURNS TRIGGER AS $$
DECLARE
  o stock_movements%ROWTYPE;
BEGIN
  IF NEW.type = 'REVERSAL' THEN
    SELECT * INTO o FROM stock_movements WHERE id = NEW."reversalOfId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'REVERSAL_MISMATCH: there is no movement to reverse';
    END IF;
    IF o."materialId" <> NEW."materialId" OR o.quantity <> NEW.quantity OR o.direction = NEW.direction THEN
      RAISE EXCEPTION 'REVERSAL_MISMATCH: a reversal must undo the same material and quantity in the opposite direction';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_guard_reversal
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION guard_reversal();

-- ── 6. Count status: no blanks, one opening count, nothing after approval ──
CREATE OR REPLACE FUNCTION guard_count_submission() RETURNS TRIGGER AS $$
DECLARE
  v_missing_qty  INT;
  v_missing_rate INT;
  v_other        INT;
BEGIN
  IF OLD.status = 'APPROVED' THEN
    RAISE EXCEPTION 'COUNT_LOCKED: an approved count is final';
  END IF;

  IF NEW.status = 'APPROVED' AND OLD.status IS DISTINCT FROM 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'NOT_PENDING: only a count that was sent to the owner can be approved';
  END IF;

  -- Leaving DRAFT / REJECTED for review, or being approved: nothing may be blank.
  IF NEW.status IN ('PENDING_APPROVAL', 'APPROVED') AND OLD.status IS DISTINCT FROM NEW.status THEN
    SELECT COUNT(*) INTO v_missing_qty
    FROM stock_count_lines WHERE "stockCountId" = NEW.id AND "countedQty" IS NULL;
    IF v_missing_qty > 0 THEN
      RAISE EXCEPTION 'COUNT_INCOMPLETE: % material(s) not yet counted', v_missing_qty;
    END IF;

    IF NEW."isOpening" THEN
      SELECT COUNT(*) INTO v_missing_rate
      FROM stock_count_lines WHERE "stockCountId" = NEW.id AND "countedQty" > 0 AND "unitRate" IS NULL;
      IF v_missing_rate > 0 THEN
        RAISE EXCEPTION 'COUNT_INCOMPLETE: % material(s) without a rate', v_missing_rate;
      END IF;
    END IF;
  END IF;

  -- Only one opening count may ever be approved. A second would reset stock to any number with no difference showing.
  IF NEW."isOpening" AND NEW.status = 'APPROVED' AND OLD.status IS DISTINCT FROM 'APPROVED' THEN
    PERFORM pg_advisory_xact_lock(hashtext('vijaya_opening_count'));
    SELECT COUNT(*) INTO v_other
    FROM stock_counts WHERE "isOpening" AND status = 'APPROVED' AND id <> NEW.id;
    IF v_other > 0 THEN
      RAISE EXCEPTION 'OPENING_ALREADY_DONE: an opening count has already been approved';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_guard_count_submission
  BEFORE UPDATE ON stock_counts
  FOR EACH ROW EXECUTE FUNCTION guard_count_submission();

-- A count is kept for ever.
CREATE OR REPLACE FUNCTION guard_count_delete() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'COUNT_LOCKED: counts and their lines are kept, never deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_guard_count_delete BEFORE DELETE ON stock_counts
  FOR EACH ROW EXECUTE FUNCTION guard_count_delete();
CREATE TRIGGER trg_guard_count_line_delete BEFORE DELETE ON stock_count_lines
  FOR EACH ROW EXECUTE FUNCTION guard_count_delete();

-- Count lines can be changed only while the count is with the storekeeper (draft, or sent back), and the system
-- quantity frozen when counting began never changes.
CREATE OR REPLACE FUNCTION guard_count_line_lock() RETURNS TRIGGER AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT status INTO v_status FROM stock_counts WHERE id = OLD."stockCountId";
  IF v_status NOT IN ('DRAFT', 'REJECTED') THEN
    RAISE EXCEPTION 'COUNT_LOCKED: this count is % and its lines can no longer be changed', v_status;
  END IF;
  IF NEW."systemQty" IS DISTINCT FROM OLD."systemQty" OR NEW."materialId" <> OLD."materialId" THEN
    RAISE EXCEPTION 'COUNT_SYSTEM_FROZEN: the system quantity is frozen when counting starts';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_guard_count_line_lock BEFORE UPDATE ON stock_count_lines
  FOR EACH ROW EXECUTE FUNCTION guard_count_line_lock();

-- ── 7. THE LEDGER IS APPEND-ONLY ───────────────────────────────────
--  No UPDATE, no DELETE, no TRUNCATE. Corrections are REVERSAL rows. The one exception is the demo reset, which
--  sets vijaya.allow_reset = 'on' inside its own transaction (and only when DEMO_MODE=true in the app).
CREATE OR REPLACE FUNCTION block_ledger_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'LEDGER_APPEND_ONLY: % is kept as it was written. Post a correcting entry instead of %.', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION block_ledger_truncate() RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('vijaya.allow_reset', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'LEDGER_APPEND_ONLY: % cannot be emptied', TG_TABLE_NAME;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_block_movement_update BEFORE UPDATE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION block_ledger_mutation();
CREATE TRIGGER trg_block_movement_delete BEFORE DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION block_ledger_mutation();
CREATE TRIGGER trg_block_movement_truncate BEFORE TRUNCATE ON stock_movements
  FOR EACH STATEMENT EXECUTE FUNCTION block_ledger_truncate();

CREATE TRIGGER trg_block_audit_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION block_ledger_mutation();
CREATE TRIGGER trg_block_audit_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION block_ledger_truncate();

-- Artifact versions are immutable: a version is superseded, never edited.
CREATE TRIGGER trg_block_artifact_version_update BEFORE UPDATE OR DELETE ON artifact_versions
  FOR EACH ROW EXECUTE FUNCTION block_ledger_mutation();
CREATE TRIGGER trg_block_artifact_version_truncate BEFORE TRUNCATE ON artifact_versions
  FOR EACH STATEMENT EXECUTE FUNCTION block_ledger_truncate();

-- ── 8. BALANCE MAINTENANCE — weighted average, in the same transaction ──
--  Balance is DERIVED: inserting a movement is the only way it changes.
--    IN  (receipt, opening, scrap in, a reversal bringing stock back):
--        new average = (old value + incoming value) / (old quantity + incoming quantity)
--        (when stock on hand was nil or negative, the new average is simply the incoming rate)
--    RETURN and COUNT_ADJUSTMENT come in at the current average and do not move it.
--    OUT leaves the average unchanged; value is taken out at the current average.
--  The rate is the database's to decide wherever the business rule names it, so a caller cannot choose it:
--    OUT, RETURN, COUNT_ADJUSTMENT → the current average;  OPENING → the count line's rate.
CREATE OR REPLACE FUNCTION apply_stock_movement() RETURNS TRIGGER AS $$
DECLARE
  v_qty       NUMERIC(18,4);
  v_rate      NUMERIC(18,4);
  v_value     NUMERIC(18,2);
  v_new_qty   NUMERIC(18,4);
  v_new_rate  NUMERIC(18,4);
  v_new_val   NUMERIC(18,2);
  v_line_rate NUMERIC(18,4);
BEGIN
  -- Lock this material's balance row for the rest of the transaction.
  SELECT quantity, "averageRate", "stockValue" INTO v_qty, v_rate, v_value
  FROM stock_balances WHERE "materialId" = NEW."materialId" FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_BALANCE_ROW: this material has no balance row';
  END IF;

  IF NEW.type = 'OPENING' THEN
    SELECT "unitRate" INTO v_line_rate FROM stock_count_lines WHERE id = NEW."stockCountLineId";
    IF v_line_rate IS NULL OR v_line_rate <= 0 THEN
      RAISE EXCEPTION 'OPENING_RATE_MISSING: opening stock needs a rate from the last purchase invoice';
    END IF;
    NEW.rate := v_line_rate;
  ELSIF NEW.direction = 'OUT' OR NEW.type IN ('RETURN', 'COUNT_ADJUSTMENT') THEN
    NEW.rate := v_rate;
  END IF;

  IF NEW.direction = 'IN' THEN
    v_new_qty := v_qty + NEW.quantity;
    IF NEW.type IN ('RETURN', 'COUNT_ADJUSTMENT') OR v_new_qty <= 0 THEN
      v_new_rate := v_rate;
    ELSIF v_qty <= 0 THEN
      -- Stock on hand was nil or negative (paperwork lagged the floor): everything now on hand is what just came in.
      -- Without this, a receipt after a negative balance would be averaged against a negative value.
      v_new_rate := NEW.rate;
    ELSE
      v_new_rate := ROUND((v_value + (NEW.quantity * NEW.rate)) / v_new_qty, 4);
    END IF;
  ELSE
    v_new_qty  := v_qty - NEW.quantity;
    v_new_rate := v_rate;
  END IF;

  v_new_val := ROUND(v_new_qty * v_new_rate, 2);

  -- Negative stock is ALLOWED but flagged: shop-floor paperwork lags reality, and blocking it teaches people to
  -- lie. The tool layer turns a negative balance into a notification for the owner.
  IF v_new_qty < 0 THEN
    RAISE NOTICE 'NEGATIVE_STOCK: material % is now %', NEW."materialId", v_new_qty;
  END IF;

  UPDATE stock_balances
     SET quantity = v_new_qty, "averageRate" = v_new_rate, "stockValue" = v_new_val,
         "lastMovementAt" = NEW."movementDate", "updatedAt" = NOW()
   WHERE "materialId" = NEW."materialId";

  NEW."balanceQtyAfter"   := v_new_qty;
  NEW."balanceRateAfter"  := v_new_rate;
  NEW."balanceValueAfter" := v_new_val;
  NEW.value               := ROUND(NEW.quantity * NEW.rate, 2);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Named so it sorts AFTER trg_guard_*: PostgreSQL fires same-event triggers in name order, and the guards must
-- refuse a bad movement before any balance is touched (and so the owner is told the real reason).
CREATE TRIGGER trg_stock_movement_apply
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION apply_stock_movement();

-- ── 9. Every material gets a balance row automatically ─────────────
CREATE OR REPLACE FUNCTION create_balance_row() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO stock_balances ("materialId", quantity, "averageRate", "stockValue", "updatedAt")
  VALUES (NEW.id, 0, 0, 0, NOW())
  ON CONFLICT ("materialId") DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_create_balance_row
  AFTER INSERT ON materials
  FOR EACH ROW EXECUTE FUNCTION create_balance_row();

-- ── 10. Views ──────────────────────────────────────────────────────
--  Reconciliation: the ledger must always equal the balance. Any row returned means something is very wrong.
CREATE OR REPLACE VIEW v_balance_integrity AS
SELECT
  m.id                        AS material_id,
  m.name                      AS material_name,
  b.quantity                  AS balance_qty,
  COALESCE(SUM(CASE WHEN mv.direction = 'IN' THEN mv.quantity ELSE -mv.quantity END), 0) AS ledger_qty,
  b.quantity - COALESCE(SUM(CASE WHEN mv.direction = 'IN' THEN mv.quantity ELSE -mv.quantity END), 0) AS drift
FROM materials m
JOIN stock_balances b ON b."materialId" = m.id
LEFT JOIN stock_movements mv ON mv."materialId" = m.id
GROUP BY m.id, m.name, b.quantity
HAVING ABS(b.quantity - COALESCE(SUM(CASE WHEN mv.direction = 'IN' THEN mv.quantity ELSE -mv.quantity END), 0)) > 0.0001;

--  The leak report: every count difference per material, never overwritten, accumulating until the pattern shows.
--  The opening count is excluded (on go-live every material "differs" from zero; none of that is leakage), and only
--  real differences can be unexplained.
CREATE OR REPLACE VIEW v_material_leak AS
SELECT
  m.id   AS material_id,
  m.name AS material_name,
  m.uom,
  COUNT(scl.id)                                    AS times_counted,
  COUNT(*) FILTER (WHERE scl."differenceQty" <> 0) AS times_mismatched,
  SUM(scl."differenceQty")                         AS net_difference_qty,
  SUM(CASE WHEN scl."differenceQty" < 0 THEN ABS(scl."differenceQty") ELSE 0 END) AS total_shortage_qty,
  SUM(ABS(scl."differenceQty") * b."averageRate")  AS total_variance_value,
  COUNT(*) FILTER (WHERE scl."differenceQty" <> 0
                     AND (scl."reasonCode" IS NULL OR scl."reasonCode" = 'UNEXPLAINED')) AS unexplained_count,
  MAX(sc."countDate")                              AS last_counted
FROM stock_count_lines scl
JOIN stock_counts sc ON sc.id = scl."stockCountId" AND sc.status = 'APPROVED' AND sc."isOpening" = false
JOIN materials m      ON m.id = scl."materialId"
JOIN stock_balances b ON b."materialId" = m.id
GROUP BY m.id, m.name, m.uom
ORDER BY total_variance_value DESC NULLS LAST;

--  Per-job material cost falls out of the ledger.
CREATE OR REPLACE VIEW v_job_material_cost AS
SELECT
  j.id     AS job_id,
  j.number AS job_number,
  p.name   AS customer_name,
  j."productDescription",
  j.quantity,
  SUM(CASE WHEN mv.type = 'ISSUE'  THEN mv.value ELSE 0 END) AS issued_value,
  SUM(CASE WHEN mv.type = 'RETURN' THEN mv.value ELSE 0 END) AS returned_value,
  SUM(CASE WHEN mv.type = 'ISSUE' THEN mv.value WHEN mv.type = 'RETURN' THEN -mv.value ELSE 0 END) AS net_material_cost,
  CASE WHEN j.quantity > 0 THEN ROUND(
    SUM(CASE WHEN mv.type = 'ISSUE' THEN mv.value WHEN mv.type = 'RETURN' THEN -mv.value ELSE 0 END) / j.quantity, 2)
  END AS material_cost_per_piece
FROM jobs j
JOIN parties p ON p.id = j."customerId"
LEFT JOIN stock_movements mv ON mv."jobId" = j.id
GROUP BY j.id, j.number, p.name, j."productDescription", j.quantity;

--  BOM vs actual: where the material really goes.
CREATE OR REPLACE VIEW v_bom_vs_actual AS
SELECT
  j.number          AS job_number,
  m.name            AS material_name,
  m.uom,
  bl."requiredQty"  AS bom_required,
  bl."issuedQty"    AS actually_issued,
  bl."returnedQty"  AS returned,
  bl."issuedQty" - bl."returnedQty" AS net_consumed,
  (bl."issuedQty" - bl."returnedQty") - bl."requiredQty" AS variance,
  CASE WHEN bl."requiredQty" > 0 THEN ROUND(
    (((bl."issuedQty" - bl."returnedQty") - bl."requiredQty") / bl."requiredQty") * 100, 2)
  END AS variance_pct
FROM job_bom_lines bl
JOIN jobs j      ON j.id = bl."jobId"
JOIN materials m ON m.id = bl."materialId";

--  Reorder alerts: standing stock only (purchasing is reactive).
CREATE OR REPLACE VIEW v_reorder_alerts AS
SELECT
  m.id, m.name, m.uom,
  b.quantity AS on_hand,
  m."minimumLevel",
  m."minimumLevel" - b.quantity AS shortfall
FROM materials m
JOIN stock_balances b ON b."materialId" = m.id
WHERE m."stockType" = 'STANDING' AND m."isActive" AND m."minimumLevel" IS NOT NULL AND b.quantity < m."minimumLevel";
