-- ═══════════════════════════════════════════════════════════════════
--  VIJAYA ELECTRONICS ERP — INVENTORY INVARIANTS
--  Run after `prisma migrate`. These are NOT optional.
--
--  Why database-level and not just in the tool layer:
--  agents write to these tables. An agent will eventually be wrong,
--  or be talked into being wrong. The tool layer is the first line of
--  defence; this is the one that cannot be argued with.
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. Quantities and rates are never negative ────────────────────
ALTER TABLE stock_movements
  ADD CONSTRAINT chk_movement_qty_positive  CHECK (quantity > 0),
  ADD CONSTRAINT chk_movement_rate_positive CHECK (rate >= 0);

ALTER TABLE stock_balances
  ADD CONSTRAINT chk_balance_rate_positive CHECK ("averageRate" >= 0);

-- ── 2. Inspection split must add up ───────────────────────────────
ALTER TABLE goods_receipt_lines
  ADD CONSTRAINT chk_grn_split
    CHECK ("acceptedQty" + "rejectedQty" = "receivedQty"),
  ADD CONSTRAINT chk_grn_qty_positive
    CHECK ("receivedQty" > 0 AND "acceptedQty" >= 0 AND "rejectedQty" >= 0);

-- ── 3. BOM quantities are positive ────────────────────────────────
ALTER TABLE job_bom_lines
  ADD CONSTRAINT chk_bom_qty_positive
    CHECK ("qtyPerPiece" > 0 AND "requiredQty" > 0);

ALTER TABLE jobs
  ADD CONSTRAINT chk_job_qty_positive CHECK (quantity > 0);

-- ── 4. Count difference must equal counted − system ───────────────
--     Stops a "corrected" difference from being slipped in.
ALTER TABLE stock_count_lines
  ADD CONSTRAINT chk_count_difference
    CHECK ("differenceQty" = "countedQty" - "systemQty");

-- ── 5. Direction must match movement type ─────────────────────────
ALTER TABLE stock_movements
  ADD CONSTRAINT chk_movement_direction CHECK (
    (type IN ('OPENING','RECEIPT','RETURN','SCRAP_IN') AND direction = 'IN')
    OR (type IN ('ISSUE','REJECT_RETURN','SCRAP_SALE') AND direction = 'OUT')
    OR (type IN ('COUNT_ADJUSTMENT','REVERSAL'))  -- either direction
  );

-- ── 6. Every ISSUE and RETURN must name a job ─────────────────────
--     This is what makes per-job material cost automatic.
ALTER TABLE stock_movements
  ADD CONSTRAINT chk_issue_has_job CHECK (
    type NOT IN ('ISSUE','RETURN') OR "jobId" IS NOT NULL
  );

-- ── 7. COUNT_ADJUSTMENT can ONLY come from an approved count ──────
--     The heart of "stop overwriting". Stock cannot be silently
--     corrected by anything except an owner-approved count line.
ALTER TABLE stock_movements
  ADD CONSTRAINT chk_adjustment_has_count CHECK (
    type <> 'COUNT_ADJUSTMENT' OR "stockCountLineId" IS NOT NULL
  );

-- OPENING movements need the same protection: they may only come from the
-- single approved opening count. Without this, an OPENING row could add
-- stock at any rate, at any time, with no count and no approval.
ALTER TABLE stock_movements
  ADD CONSTRAINT chk_opening_has_count CHECK (
    type <> 'OPENING' OR "stockCountLineId" IS NOT NULL
  );

CREATE OR REPLACE FUNCTION guard_count_adjustment()
RETURNS TRIGGER AS $$
DECLARE
  v_status     TEXT;
  v_is_opening BOOLEAN;
BEGIN
  IF NEW.type IN ('COUNT_ADJUSTMENT', 'OPENING') THEN
    SELECT sc.status, sc."isOpening" INTO v_status, v_is_opening
    FROM stock_count_lines scl
    JOIN stock_counts sc ON sc.id = scl."stockCountId"
    WHERE scl.id = NEW."stockCountLineId";

    IF v_status IS DISTINCT FROM 'APPROVED' THEN
      RAISE EXCEPTION
        'Stock adjustment blocked: count is % , owner approval required',
        COALESCE(v_status, 'MISSING');
    END IF;

    -- The opening count posts OPENING movements; every other count posts
    -- COUNT_ADJUSTMENT. Mixing them up would either value opening stock at
    -- the (zero) average or hide real differences from the leak report.
    IF NEW.type = 'OPENING' AND v_is_opening IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'OPENING movements can only come from the opening count';
    END IF;
    IF NEW.type = 'COUNT_ADJUSTMENT' AND v_is_opening THEN
      RAISE EXCEPTION 'The opening count posts OPENING movements, not COUNT_ADJUSTMENT';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_guard_count_adjustment
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION guard_count_adjustment();

-- ── 7b. The opening count ─────────────────────────────────────────
--     Go-live happens once. The storekeeper counts every material and
--     enters the rate from its last purchase invoice (invoice number is
--     optional). Without a rate, opening stock would be valued at ₹0 and
--     every job cost after it would be understated.
ALTER TABLE stock_count_lines
  ADD CONSTRAINT chk_count_rate_positive
    CHECK ("unitRate" IS NULL OR "unitRate" > 0);

CREATE OR REPLACE FUNCTION guard_count_submission()
RETURNS TRIGGER AS $$
DECLARE
  v_missing_qty  INT;
  v_missing_rate INT;
  v_other        INT;
BEGIN
  -- Leaving DRAFT/REJECTED for review or approval: nothing may be blank.
  IF NEW.status IN ('PENDING_APPROVAL', 'APPROVED')
     AND OLD.status IS DISTINCT FROM NEW.status THEN

    SELECT COUNT(*) INTO v_missing_qty
    FROM stock_count_lines
    WHERE "stockCountId" = NEW.id AND "countedQty" IS NULL;
    IF v_missing_qty > 0 THEN
      RAISE EXCEPTION 'COUNT_INCOMPLETE: % material(s) not yet counted', v_missing_qty;
    END IF;

    IF NEW."isOpening" THEN
      -- Rate required on every line that has stock. Invoice number is optional.
      SELECT COUNT(*) INTO v_missing_rate
      FROM stock_count_lines
      WHERE "stockCountId" = NEW.id AND "countedQty" > 0 AND "unitRate" IS NULL;
      IF v_missing_rate > 0 THEN
        RAISE EXCEPTION 'COUNT_INCOMPLETE: % material(s) without a rate', v_missing_rate;
      END IF;
    END IF;
  END IF;

  -- Only one opening count may ever be approved. A second one would be a
  -- way to reset stock to any number without a single difference showing.
  IF NEW."isOpening" AND NEW.status = 'APPROVED'
     AND OLD.status IS DISTINCT FROM 'APPROVED' THEN
    PERFORM pg_advisory_xact_lock(hashtext('vijaya_opening_count'));
    SELECT COUNT(*) INTO v_other
    FROM stock_counts
    WHERE "isOpening" AND status = 'APPROVED' AND id <> NEW.id;
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

-- ── 8. THE LEDGER IS APPEND-ONLY ──────────────────────────────────
--     No UPDATE. No DELETE. Ever. Corrections are REVERSAL rows.
--     This single guard is what makes the audit trail worth trusting.
CREATE OR REPLACE FUNCTION block_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'stock_movements is append-only. Post a REVERSAL movement instead of %.',
    TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_block_movement_update
  BEFORE UPDATE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION block_ledger_mutation();

CREATE TRIGGER trg_block_movement_delete
  BEFORE DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION block_ledger_mutation();

-- Audit events are equally immutable.
CREATE TRIGGER trg_block_audit_update
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION block_ledger_mutation();

-- ── 9. BALANCE MAINTENANCE — weighted average, in-transaction ─────
--     Balance is DERIVED. The application never writes it directly;
--     inserting a movement is the only way it changes.
--
--     Weighted average rule (confirmed with owner):
--       IN  → new_avg = (old_value + incoming_value) / (old_qty + in_qty)
--       OUT → average UNCHANGED, value reduced at the current average
--
--     Returns from the floor come back IN at the current average, so
--     they do not distort the rate.
CREATE OR REPLACE FUNCTION apply_stock_movement()
RETURNS TRIGGER AS $$
DECLARE
  v_qty      NUMERIC(18,4);
  v_rate     NUMERIC(18,4);
  v_value    NUMERIC(18,2);
  v_new_qty  NUMERIC(18,4);
  v_new_rate NUMERIC(18,4);
  v_new_val  NUMERIC(18,2);
BEGIN
  -- Lock this material's balance row for the transaction
  SELECT quantity, "averageRate", "stockValue"
    INTO v_qty, v_rate, v_value
  FROM stock_balances
  WHERE "materialId" = NEW."materialId"
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No stock_balances row for material %', NEW."materialId";
  END IF;

  IF NEW.direction = 'IN' THEN
    v_new_qty := v_qty + NEW.quantity;
    IF v_new_qty > 0 THEN
      -- RETURN comes back at the existing average, not a new rate
      IF NEW.type = 'RETURN' THEN
        v_new_rate := v_rate;
      ELSE
        v_new_rate := ROUND(
          (v_value + (NEW.quantity * NEW.rate)) / v_new_qty, 4);
      END IF;
    ELSE
      v_new_rate := v_rate;
    END IF;
  ELSE
    v_new_qty  := v_qty - NEW.quantity;
    v_new_rate := v_rate;  -- outward never moves the average
  END IF;

  v_new_val := ROUND(v_new_qty * v_new_rate, 2);

  -- Negative stock is ALLOWED but flagged: shop-floor paperwork lags
  -- reality, and blocking it teaches the storekeeper to lie. The agent
  -- turns the notice below into a task for the owner.
  IF v_new_qty < 0 THEN
    RAISE NOTICE 'NEGATIVE STOCK on material % → %', NEW."materialId", v_new_qty;
  END IF;

  UPDATE stock_balances
     SET quantity         = v_new_qty,
         "averageRate"    = v_new_rate,
         "stockValue"     = v_new_val,
         "lastMovementAt" = NEW."movementDate",
         "updatedAt"      = NOW()
   WHERE "materialId" = NEW."materialId";

  -- Stamp the running balance onto the ledger row itself
  NEW."balanceQtyAfter"   := v_new_qty;
  NEW."balanceRateAfter"  := v_new_rate;
  NEW."balanceValueAfter" := v_new_val;
  NEW.value               := ROUND(NEW.quantity * NEW.rate, 2);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_apply_stock_movement
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION apply_stock_movement();

-- ── 10. Every material gets a balance row automatically ───────────
CREATE OR REPLACE FUNCTION create_balance_row()
RETURNS TRIGGER AS $$
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

-- ── 11. Reconciliation view — the ledger must always equal the balance
--        Run nightly. Any row returned means something is very wrong.
CREATE OR REPLACE VIEW v_balance_integrity AS
SELECT
  m.id                        AS material_id,
  m.name                      AS material_name,
  b.quantity                  AS balance_qty,
  COALESCE(SUM(
    CASE WHEN mv.direction = 'IN' THEN mv.quantity ELSE -mv.quantity END
  ), 0)                       AS ledger_qty,
  b.quantity - COALESCE(SUM(
    CASE WHEN mv.direction = 'IN' THEN mv.quantity ELSE -mv.quantity END
  ), 0)                       AS drift
FROM materials m
JOIN stock_balances b ON b."materialId" = m.id
LEFT JOIN stock_movements mv ON mv."materialId" = m.id
GROUP BY m.id, m.name, b.quantity
HAVING ABS(b.quantity - COALESCE(SUM(
  CASE WHEN mv.direction = 'IN' THEN mv.quantity ELSE -mv.quantity END
), 0)) > 0.0001;

-- ── 12. THE LEAK REPORT — what the owner actually bought this for ──
--        Every count difference, per material, never overwritten,
--        accumulating until the pattern is undeniable.
CREATE OR REPLACE VIEW v_material_leak AS
SELECT
  m.id   AS material_id,
  m.name AS material_name,
  m.uom,
  COUNT(scl.id)                                   AS times_counted,
  COUNT(*) FILTER (WHERE scl."differenceQty" <> 0) AS times_mismatched,
  SUM(scl."differenceQty")                        AS net_difference_qty,
  SUM(CASE WHEN scl."differenceQty" < 0
           THEN ABS(scl."differenceQty") ELSE 0 END) AS total_shortage_qty,
  SUM(ABS(scl."differenceQty") * b."averageRate")    AS total_variance_value,
  -- Only real differences count as unexplained. (Previously a matching line
  -- with no reason was counted too, inflating the owner's headline number.)
  COUNT(*) FILTER (WHERE scl."differenceQty" <> 0
                     AND (scl."reasonCode" IS NULL
                          OR scl."reasonCode" = 'UNEXPLAINED'))
                                                   AS unexplained_count,
  MAX(sc."countDate")                              AS last_counted
FROM stock_count_lines scl
-- The opening count is excluded: on go-live every material "differs" from
-- zero, and none of that is leakage.
JOIN stock_counts sc ON sc.id = scl."stockCountId"
                    AND sc.status = 'APPROVED'
                    AND sc."isOpening" = false
JOIN materials m     ON m.id = scl."materialId"
JOIN stock_balances b ON b."materialId" = m.id
GROUP BY m.id, m.name, m.uom
ORDER BY total_variance_value DESC NULLS LAST;

-- ── 13. Per-job material cost — falls out free from the ledger ────
CREATE OR REPLACE VIEW v_job_material_cost AS
SELECT
  j.id     AS job_id,
  j.number AS job_number,
  p.name   AS customer_name,
  j."productDescription",
  j.quantity,
  SUM(CASE WHEN mv.type = 'ISSUE'  THEN mv.value ELSE 0 END) AS issued_value,
  SUM(CASE WHEN mv.type = 'RETURN' THEN mv.value ELSE 0 END) AS returned_value,
  SUM(CASE WHEN mv.type = 'ISSUE'  THEN mv.value
           WHEN mv.type = 'RETURN' THEN -mv.value ELSE 0 END) AS net_material_cost,
  CASE WHEN j.quantity > 0 THEN ROUND(
    SUM(CASE WHEN mv.type = 'ISSUE'  THEN mv.value
             WHEN mv.type = 'RETURN' THEN -mv.value ELSE 0 END) / j.quantity, 2)
  END AS material_cost_per_piece
FROM jobs j
JOIN parties p ON p.id = j."customerId"
LEFT JOIN stock_movements mv ON mv."jobId" = j.id
GROUP BY j.id, j.number, p.name, j."productDescription", j.quantity;

-- ── 14. BOM vs actual — where copper really goes ──────────────────
CREATE OR REPLACE VIEW v_bom_vs_actual AS
SELECT
  j.number                    AS job_number,
  m.name                      AS material_name,
  m.uom,
  bl."requiredQty"            AS bom_required,
  bl."issuedQty"              AS actually_issued,
  bl."returnedQty"            AS returned,
  bl."issuedQty" - bl."returnedQty"                 AS net_consumed,
  (bl."issuedQty" - bl."returnedQty") - bl."requiredQty" AS variance,
  CASE WHEN bl."requiredQty" > 0 THEN ROUND(
    (((bl."issuedQty" - bl."returnedQty") - bl."requiredQty")
      / bl."requiredQty") * 100, 2)
  END AS variance_pct
FROM job_bom_lines bl
JOIN jobs j     ON j.id = bl."jobId"
JOIN materials m ON m.id = bl."materialId";

-- ── 15. Reorder alerts — standing stock only (purchasing is reactive)
CREATE OR REPLACE VIEW v_reorder_alerts AS
SELECT
  m.id, m.name, m.uom,
  b.quantity      AS on_hand,
  m."minimumLevel",
  m."minimumLevel" - b.quantity AS shortfall
FROM materials m
JOIN stock_balances b ON b."materialId" = m.id
WHERE m."stockType" = 'STANDING'
  AND m."isActive"
  AND m."minimumLevel" IS NOT NULL
  AND b.quantity < m."minimumLevel";
