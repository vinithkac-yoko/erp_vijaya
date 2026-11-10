# What the client's own paperwork shows (received 2026-10-20)

Five files from the client, and a picture of four lines (part number, description, quantity). Nothing here is built yet: it
changes a documented rule (BUSINESS_FLOW §1 and §7: "designs never repeat, a repeat order is a new job with a fresh BOM"), so it waits
for Kasi's answers (section M of `docs/CLIENT_CONFIRMATIONS.md`).

## The headline: everything runs by part number
Every product the customer buys has a part number, and the factory puts it on the product. Part numbers are 11 digits starting 90
(for example `90301030002`), written in front of the description: `90308200008-TXFR FOR M634VOC`. The picture lists four of them with
quantities: 90305600201 (492), 90305601211 (350), 90308000101 (325), 90308000201 (400).
Today the system has **no part number anywhere**: a job has a free-text description, a customer PO has a number and a date but no lines,
and a BOM belongs to one job.

## File by file
| File | What it is | What it tells us |
|---|---|---|
| `Work_Order_Print.xlsx` | The factory's **Work Order**, form `VEC 47.001 / Rev-01 / 28.03.2025`, Production department, Kolapakkam unit | Top: **Customer Part No**, Customer Name, **Work Order Qty**, **Cust PO No/Date**, **WO No/Date**, **DC No**. Table (12 rows): Sl.No, **Product Code**, Item Description, **IGIR No/Date**, UOM, **BOM**, **Required**, **Issued**, **Balance**. Bottom: Requested by (PED / Planning Department), Issued by + date, Received by + date. Footer: "Request to be given one day in advance. Material will be issued between 11.00 am and 2.00 pm". This is our **issue slip**, in their layout. "IGIR" is probably the inward goods inspection report: the receipt the material came in on. |
| `WIRE_PO.pdf` (Mahalakshmi Wires, 7-Oct-26, ₹7,44,965) | A **purchase order** printed from their accounts program (looks like Tally) | 14 lines over 3 pages ("continued …"). Wire bought **per gauge as separate items** (`17 SWG NON SS 1.42mm` … `25 SWG SS 0.508mm`), rates differ by gauge (₹1,665 to ₹1,696 a kg), quantities to 4 decimals. Also varnish, thinner, enamel remover, polyester film, fibre glass sleeve. Header: **Voucher No. 229**, **Reference `VE/MW-229/2026-2027`**, Dated, Invoice To / Consignee (Ship to) / Supplier (Bill from) with GSTIN and state code, a **Due on** date on every line, quantity and rate **with their own unit** ("per"), amounts in lakh style, **CGST 9% + SGST 9%**, **Round Off**, **amount in words**, company PAN, "for Vijaya Electronics - Authorised Signatory". |
| `Packing_Tape_PO….pdf` (Shyaam Packages, 13-Aug-26, ₹54,425) | Same layout | Reference `VE/CPPL-147/2026/2027 -Amended`: **a PO that was changed after it went out**. A line **"Cylinder Charges"** (2 Nos @ ₹9,000): a charge, not stock. Tape bought in **Nos** although described in metres ("48 MM X 50 MTRS"). |
| `ARBITAL_Po.pdf` (Arbital Solutions, 8-Sep-26, ₹1,96,965.60) | Same layout | Voucher **178**, reference `VE/ASPL-177/…` (reference and voucher numbers differ by one). Solder bar (kg), flux and enamel remover (litres). Round-off absent here, total has paise. |
| `Medha_InvNo.276.pdf` (9-Sep-26, ₹7,20,716.39) | A **tax invoice** to a customer (Medha Servo Drives, Telangana) | **e-invoice** with IRN, QR code and e-way bill number; IGST 18% (other state), HSN 85041010; **eight part numbers**, each with its own rate (₹116.60 to ₹181.16 a piece) and quantity (200 to 1,836; 4,383 pieces in all); the customer's order number and date; bank details; four printed copies (recipient, transporter, supplier, extra). Not something this system can produce (the IRN and QR come from the government portal). |

## What the five files agree on
- Vijaya Electronics: No.3, Anna Main Road, Maruthi Nagar, Kollapakkam 600 128; GSTIN 33BKVPS8263D1ZM; Tamil Nadu code 33; PAN BKVPS8263D.
- Purchase tax is CGST+SGST 9%+9% within Tamil Nadu; sales to another state are IGST 18%.
- A PO number is a **running voucher number** across all suppliers (147 in August, 178 in September, 229 in October), printed with a reference that carries a short supplier code and the financial year.
