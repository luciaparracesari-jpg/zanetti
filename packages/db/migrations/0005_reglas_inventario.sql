-- Reglas del inventario que Drizzle no expresa en el esquema.

-- 1. El libro de movimientos es inmutable: una corrección siempre es un movimiento nuevo.
CREATE TRIGGER inventory_movements_immutable
  BEFORE UPDATE OR DELETE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION erp_forbid_change();
--> statement-breakpoint

-- 2. Existencias por SKU y almacén.
--    on_hand    = físico en todas las ubicaciones (incluye el faltante autorizado, que es negativo)
--    blocked    = físico en ubicaciones de cuarentena y merma (no se vende ni se envía)
--    reserved   = pedidos pagados sin surtir
--    committed  = transferencias autorizadas sin enviar
--    in_transit = enviado hacia este almacén y aún no recibido
--    available  = on_hand - blocked - reserved - committed
--    value      = valor al costo del lote (FIFO); el saldo sin lote se valúa al costo promedio del SKU
CREATE VIEW inventory_stock AS
WITH bal AS (
  SELECT b.master_sku_id,
         b.warehouse_id,
         sum(b.qty)::int AS on_hand,
         sum(CASE WHEN wl.type IN ('CUARENTENA', 'MERMA') THEN b.qty ELSE 0 END)::int AS blocked,
         sum(b.qty * coalesce(lot.unit_cost, s.avg_cost, s.current_cost, 0)) AS value
    FROM inventory_balances b
    JOIN warehouse_locations wl ON wl.id = b.location_id
    JOIN master_skus s ON s.id = b.master_sku_id
    LEFT JOIN inventory_lots lot ON lot.id = b.lot_id
   GROUP BY b.master_sku_id, b.warehouse_id
),
res AS (
  SELECT master_sku_id,
         warehouse_id,
         (coalesce(sum(qty) FILTER (WHERE source_type = 'PEDIDO'), 0))::int AS reserved,
         (coalesce(sum(qty) FILTER (WHERE source_type = 'TRANSFERENCIA'), 0))::int AS committed
    FROM inventory_reservations
   WHERE status = 'ACTIVA'
   GROUP BY master_sku_id, warehouse_id
),
transit AS (
  SELECT i.master_sku_id,
         t.destination_warehouse_id AS warehouse_id,
         sum(coalesce(i.qty_shipped, 0) - coalesce(i.qty_received, 0))::int AS in_transit
    FROM stock_transfer_items i
    JOIN stock_transfers t ON t.id = i.transfer_id
   WHERE t.status = 'ENVIADA'
   GROUP BY i.master_sku_id, t.destination_warehouse_id
),
k AS (
  SELECT master_sku_id, warehouse_id FROM bal
  UNION
  SELECT master_sku_id, warehouse_id FROM res
  UNION
  SELECT master_sku_id, warehouse_id FROM transit
)
SELECT k.master_sku_id,
       k.warehouse_id,
       coalesce(bal.on_hand, 0) AS on_hand,
       coalesce(bal.blocked, 0) AS blocked,
       coalesce(res.reserved, 0) AS reserved,
       coalesce(res.committed, 0) AS committed,
       coalesce(transit.in_transit, 0) AS in_transit,
       coalesce(bal.on_hand, 0) - coalesce(bal.blocked, 0) - coalesce(res.reserved, 0) - coalesce(res.committed, 0) AS available,
       round(coalesce(bal.value, 0), 2)::numeric(16, 2) AS value
  FROM k
  LEFT JOIN bal ON bal.master_sku_id = k.master_sku_id AND bal.warehouse_id = k.warehouse_id
  LEFT JOIN res ON res.master_sku_id = k.master_sku_id AND res.warehouse_id = k.warehouse_id
  LEFT JOIN transit ON transit.master_sku_id = k.master_sku_id AND transit.warehouse_id = k.warehouse_id;
