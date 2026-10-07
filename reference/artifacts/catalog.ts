/**
 * Machine-readable slice of docs/TOOL_CATALOG.md — what the artifact checker and the form gateway need to know about
 * each tool. In the app, generate this from the real tool registry (defineTool) instead of
 * hand-maintaining it; the shape is the contract.
 */
export type Role = 'STOREKEEPER' | 'OWNER';
const BOTH: Role[] = ['STOREKEEPER', 'OWNER'];
const OWNER: Role[] = ['OWNER'];

export interface InputSpec {
  required?: boolean;
  /** A rate/price the user must type. Never pre-filled by the agent, a launcher button or an artifact. */
  rate?: boolean;
}

export interface ToolMeta {
  name: string;
  kind: 'read' | 'write';
  roles: Role[];
  /** Inputs. Nested line fields use the "lines[].field" form. */
  inputs: Record<string, InputSpec>;
  /** Read tools: fields of each returned row that a page may display or bind. */
  outputs?: string[];
  /** Fields of the returned row that may be bound ($row) but never displayed. */
  bindOnly?: string[];
}

const t = (m: ToolMeta) => m;

export const TOOLS: Record<string, ToolMeta> = Object.fromEntries(
  [
    // ── materials ──
    t({ name: 'search_materials', kind: 'read', roles: BOTH, inputs: { query: {}, stockType: {}, includeInactive: {} },
        outputs: ['name', 'unit', 'stockType', 'onHand', 'minimumLevel', 'isScrap'], bindOnly: ['id'] }),
    t({ name: 'get_material_balance', kind: 'read', roles: BOTH, inputs: { materialIds: {}, materialNames: {} },
        outputs: ['material', 'unit', 'quantity', 'averageRate', 'value', 'minimumLevel', 'stockType', 'isNegative', 'belowMinimum'], bindOnly: ['materialId'] }),
    t({ name: 'get_movement_history', kind: 'read', roles: BOTH, inputs: { materialId: {}, materialNames: {}, jobId: {}, from: {}, to: {} },
        outputs: ['date', 'type', 'material', 'unit', 'quantity', 'rate', 'value', 'document', 'job', 'by', 'source', 'balanceAfter'], bindOnly: ['id', 'materialId', 'jobId'] }),
    t({ name: 'create_material', kind: 'write', roles: BOTH, inputs: { name: { required: true }, uom: { required: true }, stockType: { required: true }, minimumLevel: {}, hsnCode: {}, gstRate: {}, isScrap: {}, confirmNotDuplicate: {} } }),
    t({ name: 'update_material', kind: 'write', roles: BOTH, inputs: { materialId: { required: true }, name: {}, minimumLevel: {}, hsnCode: {}, gstRate: {} } }),
    t({ name: 'deactivate_material', kind: 'write', roles: BOTH, inputs: { materialId: { required: true }, reason: {} } }),
    // ── parties ──
    t({ name: 'search_parties', kind: 'read', roles: BOTH, inputs: { query: {}, role: {} },
        outputs: ['name', 'type', 'city', 'gstin', 'phone'], bindOnly: ['id'] }),
    t({ name: 'create_party', kind: 'write', roles: BOTH, inputs: { name: { required: true }, role: { required: true }, gstin: {}, city: {}, state: {}, addressLine: {}, pincode: {}, phone: {}, email: {}, confirmNotDuplicate: {} } }),
    t({ name: 'update_party', kind: 'write', roles: BOTH, inputs: { partyId: { required: true }, name: {}, gstin: {}, city: {}, state: {}, addressLine: {}, pincode: {}, phone: {}, email: {}, addRole: {} } }),
    // ── jobs ──
    t({ name: 'list_customer_pos', kind: 'read', roles: BOTH, inputs: { customerId: {}, customerName: {} },
        outputs: ['number', 'customer', 'date', 'jobs'], bindOnly: ['id', 'customerId'] }),
    t({ name: 'list_jobs', kind: 'read', roles: BOTH, inputs: { status: {}, customerId: {}, customerPoId: {}, from: {}, to: {} },
        outputs: ['number', 'customer', 'product', 'quantity', 'status', 'jobDate', 'dueDate', 'materialCost', 'costPerPiece'], bindOnly: ['id', 'customerId'] }),
    t({ name: 'get_job', kind: 'read', roles: BOTH, inputs: { jobId: { required: true } },
        outputs: ['number', 'customer', 'customerPo', 'product', 'quantity', 'status', 'materialCost',
                  'material', 'unit', 'perPiece', 'required', 'issued', 'returned'], bindOnly: ['id', 'materialId'] }),
    t({ name: 'check_job_shortage', kind: 'read', roles: BOTH, inputs: { jobId: { required: true } },
        outputs: ['material', 'unit', 'needed', 'inStock', 'short'], bindOnly: ['materialId'] }),
    t({ name: 'get_job_bom_variance', kind: 'read', roles: BOTH, inputs: { jobId: { required: true } },
        outputs: ['material', 'unit', 'planned', 'used', 'difference', 'differencePct', 'topUp'], bindOnly: ['materialId'] }),
    t({ name: 'create_customer_po', kind: 'write', roles: BOTH, inputs: { customerName: { required: true }, number: { required: true }, poDate: {} } }),
    t({ name: 'create_job', kind: 'write', roles: BOTH, inputs: { customerId: { required: true }, customerPoId: {}, productDescription: { required: true }, quantity: { required: true }, jobDate: { required: true }, dueDate: {}, type: {}, parentJobId: {} } }),
    t({ name: 'set_job_bom', kind: 'write', roles: BOTH, inputs: { jobId: { required: true }, lines: { required: true }, 'lines[].materialId': { required: true }, 'lines[].qtyPerPiece': { required: true } } }),
    t({ name: 'cancel_job', kind: 'write', roles: BOTH, inputs: { jobId: { required: true }, reason: { required: true } } }),
    // ── purchasing ──
    t({ name: 'list_purchase_orders', kind: 'read', roles: BOTH, inputs: { status: {}, supplierId: {}, materialId: {}, from: {}, to: {} },
        outputs: ['number', 'supplier', 'date', 'status', 'total', 'expectedDate', 'job'], bindOnly: ['id', 'supplierId', 'jobId'] }),
    t({ name: 'get_purchase_order', kind: 'read', roles: BOTH, inputs: { purchaseOrderId: {}, number: {} },
        outputs: ['number', 'supplier', 'date', 'status', 'total', 'expectedDate', 'job', 'material', 'unit', 'ordered', 'received', 'rate'], bindOnly: ['id', 'supplierId', 'materialId'] }),
    t({ name: 'get_purchase_price_history', kind: 'read', roles: BOTH, inputs: { materialId: {}, materialNames: {}, supplierId: {}, from: {}, to: {} },
        outputs: ['date', 'material', 'unit', 'supplier', 'rate', 'previousRate', 'changePct', 'leadTimeDays'], bindOnly: ['materialId', 'supplierId'] }),
    t({ name: 'create_purchase_order', kind: 'write', roles: BOTH, inputs: { supplierName: { required: true }, lines: { required: true },
        'lines[].materialId': { required: true }, 'lines[].quantity': { required: true }, 'lines[].rate': { required: true, rate: true },
        'lines[].hsnCode': {}, 'lines[].gstRate': {}, expectedDate: {}, triggeredByJobId: {} } }),
    t({ name: 'cancel_purchase_order', kind: 'write', roles: BOTH, inputs: { purchaseOrderId: { required: true }, reason: { required: true } } }),
    t({ name: 'approve_purchase_order', kind: 'write', roles: OWNER, inputs: { purchaseOrderId: { required: true } } }),
    t({ name: 'reject_purchase_order', kind: 'write', roles: OWNER, inputs: { purchaseOrderId: { required: true }, reason: { required: true } } }),
    // ── receipts ──
    t({ name: 'list_goods_receipts', kind: 'read', roles: BOTH, inputs: { supplierId: {}, purchaseOrderId: {}, materialNames: {}, from: {}, to: {} },
        outputs: ['number', 'date', 'supplier', 'invoiceNo', 'material', 'unit', 'receivedQty', 'acceptedQty', 'rejectedQty', 'rate'], bindOnly: ['id', 'purchaseOrderId'] }),
    t({ name: 'record_goods_receipt', kind: 'write', roles: BOTH, inputs: { supplierId: { required: true }, purchaseOrderId: {}, receiptDate: { required: true },
        supplierInvoiceNo: {}, supplierInvoiceDate: {}, supplierDcNo: {}, lines: { required: true },
        'lines[].materialId': { required: true }, 'lines[].purchaseOrderLineId': {}, 'lines[].receivedQty': { required: true },
        'lines[].acceptedQty': { required: true }, 'lines[].rejectedQty': {}, 'lines[].rejectionReason': {},
        'lines[].rate': { required: true, rate: true }, 'lines[].hsnCode': {}, 'lines[].gstRate': {} } }),
    // ── issue / return ──
    t({ name: 'issue_material', kind: 'write', roles: BOTH, inputs: { jobId: { required: true }, lines: {}, 'lines[].materialId': {}, 'lines[].quantity': {}, 'lines[].topUp': {} } }),
    t({ name: 'return_material', kind: 'write', roles: BOTH, inputs: { jobId: { required: true }, lines: { required: true }, 'lines[].materialId': { required: true }, 'lines[].quantity': { required: true }, note: {} } }),
    t({ name: 'close_job', kind: 'write', roles: BOTH, inputs: { jobId: { required: true }, nothingReturned: {} } }),
    // ── scrap ──
    t({ name: 'record_scrap_in', kind: 'write', roles: BOTH, inputs: { materialId: { required: true }, quantity: { required: true }, jobId: {} } }),
    t({ name: 'record_scrap_sale', kind: 'write', roles: BOTH, inputs: { materialId: { required: true }, buyerId: { required: true }, quantity: { required: true }, rate: { required: true, rate: true }, saleDate: { required: true }, invoiceNo: {} } }),
    t({ name: 'get_scrap_summary', kind: 'read', roles: OWNER, inputs: { from: {}, to: {} },
        outputs: ['material', 'unit', 'collected', 'sold', 'onHand', 'saleValue'], bindOnly: ['materialId'] }),
    // ── counts ──
    t({ name: 'list_counts', kind: 'read', roles: BOTH, inputs: { status: {} },
        outputs: ['number', 'date', 'type', 'status', 'counted', 'total'], bindOnly: ['id'] }),
    t({ name: 'list_count_lines', kind: 'read', roles: BOTH, inputs: { stockCountId: {}, onlyUnfinished: {} },
        outputs: ['material', 'unit', 'systemQty', 'countedQty', 'difference', 'reason', 'unitRate', 'sourceInvoiceNo', 'missing'], bindOnly: ['id', 'materialId'] }),
    t({ name: 'start_stock_count', kind: 'write', roles: BOTH, inputs: { countDate: { required: true }, isOpening: {}, materialIds: {} } }),
    t({ name: 'submit_count_line', kind: 'write', roles: BOTH, inputs: { stockCountLineId: { required: true }, countedQty: {}, reasonCode: {}, notes: {},
        unitRate: { rate: true }, sourceInvoiceNo: {}, sourceInvoiceDate: {} } }),
    t({ name: 'submit_stock_count', kind: 'write', roles: BOTH, inputs: { stockCountId: { required: true } } }),
    t({ name: 'approve_stock_count', kind: 'write', roles: OWNER, inputs: { stockCountId: { required: true } } }),
    t({ name: 'reject_stock_count', kind: 'write', roles: OWNER, inputs: { stockCountId: { required: true }, rejectionNote: { required: true } } }),
    t({ name: 'get_leak_report', kind: 'read', roles: OWNER, inputs: { from: {}, to: {}, materialNames: {} },
        outputs: ['material', 'unit', 'timesCounted', 'timesMismatched', 'netDifference', 'totalShortage', 'varianceValue', 'unexplainedCount', 'reasons', 'lastCounted'], bindOnly: ['materialId'] }),
    t({ name: 'get_count_history', kind: 'read', roles: BOTH, inputs: { materialId: {}, materialNames: {} },
        outputs: ['count', 'date', 'kind', 'statusText', 'material', 'unit', 'systemQty', 'countedQty', 'difference', 'reason', 'by', 'note'] }),
    // ── corrections, approvals, reports ──
    t({ name: 'reverse_movement', kind: 'write', roles: OWNER, inputs: { movementId: { required: true }, reason: { required: true } } }),
    t({ name: 'list_pending_approvals', kind: 'read', roles: OWNER, inputs: {},
        outputs: ['kind', 'number', 'summary', 'amount', 'waitingSince'], bindOnly: ['id'] }),
    t({ name: 'list_reorder_alerts', kind: 'read', roles: BOTH, inputs: {},
        outputs: ['material', 'unit', 'onHand', 'minimumLevel', 'shortfall'], bindOnly: ['materialId'] }),
    t({ name: 'get_stock_value', kind: 'read', roles: OWNER, inputs: { materialNames: {} },
        outputs: ['material', 'unit', 'quantity', 'averageRate', 'value', 'total'], bindOnly: ['materialId'] }),
    // What-if: same costing as get_job_cost_report for OPEN jobs, with some material rates replaced.
    // The rates here are inputs to a calculation, not prices written anywhere.
    t({ name: 'estimate_job_cost', kind: 'read', roles: OWNER, inputs: { jobIds: {}, materialNames: {}, newRate: {} },
        outputs: ['job', 'customer', 'product', 'quantity', 'currentCost', 'estimatedCost', 'change', 'changePct', 'costPerPiece'], bindOnly: ['jobId'] }),
    t({ name: 'get_job_cost_report', kind: 'read', roles: OWNER, inputs: { from: {}, to: {}, customerId: {}, customerPoId: {}, includeOpen: {} },
        outputs: ['job', 'customer', 'customerPo', 'product', 'quantity', 'statusText', 'materialCost', 'costPerPiece', 'closedAt'], bindOnly: ['jobId'] }),
    t({ name: 'get_activity', kind: 'read', roles: OWNER, inputs: { userId: {}, from: {}, to: {}, tool: {}, jobId: {} },
        outputs: ['when', 'who', 'what', 'document', 'source', 'reason'], bindOnly: ['id'] }),
    t({ name: 'share_artifact', kind: 'write', roles: OWNER, inputs: { artifactId: { required: true }, version: {} } }),
    t({ name: 'unshare_artifact', kind: 'write', roles: OWNER, inputs: { artifactId: { required: true } } }),
    t({ name: 'deactivate_party', kind: 'write', roles: BOTH, inputs: { partyId: { required: true }, reason: {} } }),
    t({ name: 'save_count_sheet', kind: 'write', roles: BOTH, inputs: { stockCountId: { required: true }, lines: { required: true } } }),
    t({ name: 'list_notifications', kind: 'read', roles: BOTH, inputs: { unreadOnly: {} }, outputs: ['when', 'message'], bindOnly: ['id'] }),
    t({ name: 'mark_notifications_read', kind: 'write', roles: BOTH, inputs: { notificationIds: { required: true } } }),
    t({ name: 'list_users', kind: 'read', roles: OWNER, inputs: {}, outputs: ['name', 'role', 'active'], bindOnly: ['id'] }),
    t({ name: 'create_user', kind: 'write', roles: OWNER, inputs: { name: { required: true }, login: { required: true }, role: { required: true } } }),
    t({ name: 'reset_user_password', kind: 'write', roles: OWNER, inputs: { userId: { required: true } } }),
    t({ name: 'deactivate_user', kind: 'write', roles: OWNER, inputs: { userId: { required: true } } }),
    t({ name: 'list_settings', kind: 'read', roles: BOTH, inputs: {}, outputs: ['setting', 'value'] }),
    t({ name: 'update_setting', kind: 'write', roles: OWNER, inputs: { key: { required: true }, value: { required: true } } }),
  ].map((m) => [m.name, m]),
);

/**
 * Printable documents. Their layout is code (fixed templates with the Vijaya letterhead), never
 * generated: they go to suppliers and the shop floor, so they must look the same every time.
 * `with` = what the template needs. Roles = who may print it.
 */
export interface PrintTemplate { roles: Role[]; with: string[]; title: string }
export const PRINT_TEMPLATES: Record<string, PrintTemplate> = {
  'purchase-order':     { roles: BOTH,  with: ['purchaseOrder'], title: 'Purchase order (to send to the supplier)' },
  'goods-receipt-note': { roles: BOTH,  with: ['receipt'],       title: 'Goods receipt note' },
  'issue-slip':         { roles: BOTH,  with: ['job'],           title: 'Issue slip / pick list for a job' },
  'count-sheet':        { roles: BOTH,  with: ['count'],         title: 'Count sheet (paper, with an empty Counted column)' },
  'job-cost-sheet':     { roles: OWNER, with: ['job'],           title: 'Job cost sheet' },
};

/**
 * The ONLY forms an artifact may open. Everyday work forms, never admin or approval forms: a steered artifact must not
 * be able to put create_user, update_setting, approve_*, reverse_movement or share_artifact in front of the owner.
 * (The launcher and the agent are not limited by this list; only artifacts are.)
 */
export const ARTIFACT_OPENABLE_FORMS = new Set([
  'record_goods_receipt', 'issue_material', 'return_material', 'create_purchase_order', 'create_job', 'create_customer_po',
  'set_job_bom', 'start_stock_count', 'record_scrap_in', 'record_scrap_sale', 'create_material', 'create_party',
]);

/** Never displayed anywhere, whatever a tool returns. */
export const FORBIDDEN_DISPLAY = /^(id|code|passwordHash|.*Id)$/;

export const readToolsFor = (role: Role) => Object.values(TOOLS).filter((t) => t.kind === 'read' && t.roles.includes(role)).map((t) => t.name);
export const artifactFormsFor = (role: Role) => writeToolsFor(role).filter((n) => ARTIFACT_OPENABLE_FORMS.has(n));
export const writeToolsFor = (role: Role) => Object.values(TOOLS).filter((t) => t.kind === 'write' && t.roles.includes(role)).map((t) => t.name);
