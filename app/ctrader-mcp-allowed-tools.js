'use strict';
// Jediný seznam nástrojů lokálního MCP serveru cTrader Desktop, které deník smí zavolat.
// Všechny jen ČTOU (discovery docs/CTRADER_MCP_DISCOVERY.md §2). Server nabízí i obchodní
// nástroje a jejich nabídku nejde vypnout, proto klient (app/ctrader-mcp.js) odmítne
// cokoli mimo tento seznam ještě před odesláním. Nový nástroj sem jen po ověření, že jen čte.
module.exports = Object.freeze([
  'get_pending_orders',
  'get_balance',
  'get_accounts_list',
  'get_positions',
  'get_symbol_details',
  'get_order_history',
  'get_account_statistics'
]);
