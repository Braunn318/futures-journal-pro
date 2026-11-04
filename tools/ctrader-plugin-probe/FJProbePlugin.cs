// Futures Journal PRO – TESTOVACÍ plugin pro cTrader (discovery, docs/ZADANI_CTRADER_MCP.md „Kdyby MCP nestačilo").
//
// JEN ČTE. Nevolá žádnou obchodní funkci (žádné ExecuteMarketOrder, PlaceLimitOrder, ModifyPosition,
// ClosePosition, CancelPendingOrder …). Posílá jen to, co vidí, na lokální příjemce
// tools/ctrader-plugin-probe/listener.js (127.0.0.1:17699). Deník ani jeho data se nepoužívají.
//
// Ověřuje: 1) spustí se plugin sám se startem cTraderu, 2) jaké číslo účtu vidí a co udělá přepnutí účtu,
// 3) jestli History obsahuje celou historii účtu, 4) co je v HistoricalOrders (počáteční SL, zrušené limitky),
// 5) události pozic a čekajících příkazů (posun SL, zrušení / expirace limitky).

using System;
using System.Collections.Generic;
using System.Text.Json;
using cAlgo.API;

namespace cAlgo.Plugins
{
    [Plugin(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
    public class FJProbePlugin : Plugin
    {
        private const string Endpoint = "http://127.0.0.1:17699/plugin-probe";
        private readonly string _runId = Guid.NewGuid().ToString("N").Substring(0, 8);
        private int _seq;

        protected override void OnStart()
        {
            Print("FJ probe plugin – start, účet {0}", Account.Number);
            Send("start", Snapshot(true));

            Positions.Opened += a => Send("position_opened", Pos(a.Position));
            Positions.Closed += a => Send("position_closed", new Dictionary<string, object> { ["position"] = Pos(a.Position), ["reason"] = a.Reason.ToString() });
            Positions.Modified += a => Send("position_modified", Pos(a.Position));
            PendingOrders.Created += a => Send("order_created", Ord(a.PendingOrder));
            PendingOrders.Modified += a => Send("order_modified", Ord(a.PendingOrder));
            PendingOrders.Filled += a => Send("order_filled", new Dictionary<string, object> { ["order"] = Ord(a.PendingOrder), ["position"] = Pos(a.Position) });
            PendingOrders.Cancelled += a => Send("order_cancelled", new Dictionary<string, object> { ["order"] = Ord(a.PendingOrder), ["reason"] = a.Reason.ToString() });

            // Každou minutu „žiju" + číslo účtu (přepnutí účtu se pozná podle změny).
            Timer.Start(TimeSpan.FromSeconds(60));
        }

        protected override void OnTimer()
        {
            Send("alive", Snapshot(false));
        }

        protected override void OnStop()
        {
            Send("stop", new Dictionary<string, object> { ["account"] = Account.Number });
        }

        private Dictionary<string, object> Snapshot(bool full)
        {
            var d = new Dictionary<string, object>
            {
                ["account"] = Account.Number,
                ["broker"] = Account.BrokerName,
                ["currency"] = Account.Asset != null ? Account.Asset.Name : null,
                ["isLive"] = Account.IsLive,
                ["balance"] = Account.Balance,
                ["historyCount"] = History.Count,
                ["historicalOrdersCount"] = HistoricalOrders.Count,
                ["positionsCount"] = Positions.Count,
                ["pendingCount"] = PendingOrders.Count,
            };
            if (!full) return d;

            var trades = new List<object>();
            foreach (var t in History)
            {
                trades.Add(new Dictionary<string, object>
                {
                    ["positionId"] = t.PositionId, ["closingDealId"] = t.ClosingDealId,
                    ["symbol"] = t.SymbolName, ["side"] = t.TradeType.ToString(),
                    ["volumeInUnits"] = t.VolumeInUnits, ["quantity"] = t.Quantity,
                    ["entryTime"] = Iso(t.EntryTime), ["entryPrice"] = t.EntryPrice,
                    ["closingTime"] = Iso(t.ClosingTime), ["closingPrice"] = t.ClosingPrice,
                    ["grossProfit"] = t.GrossProfit, ["swap"] = t.Swap, ["commissions"] = t.Commissions,
                    ["netProfit"] = t.NetProfit, ["pips"] = t.Pips, ["balance"] = t.Balance,
                    ["label"] = t.Label, ["comment"] = t.Comment,
                });
            }
            d["history"] = trades;

            var orders = new List<object>();
            for (var i = 0; i < HistoricalOrders.Count; i++)
            {
                var o = HistoricalOrders[i];
                orders.Add(new Dictionary<string, object>
                {
                    ["id"] = o.Id, ["positionId"] = o.PositionId, ["symbol"] = o.SymbolName,
                    ["side"] = o.TradeType.ToString(), ["orderType"] = o.OrderType.ToString(), ["status"] = o.Status.ToString(),
                    ["volumeInUnits"] = o.VolumeInUnits, ["filledVolumeInUnits"] = o.FilledVolumeInUnits,
                    ["targetPrice"] = o.TargetPrice, ["stopLoss"] = o.StopLoss, ["takeProfit"] = o.TakeProfit,
                    ["stopLossPips"] = o.StopLossPips, ["takeProfitPips"] = o.TakeProfitPips,
                    ["submittedTime"] = Iso(o.SubmittedTime), ["filledTime"] = IsoN(o.FilledTime), ["expirationTime"] = IsoN(o.ExpirationTime),
                    ["label"] = o.Label, ["comment"] = o.Comment,
                });
            }
            d["historicalOrders"] = orders;

            var pos = new List<object>();
            foreach (var p in Positions) pos.Add(Pos(p));
            d["positions"] = pos;
            var pend = new List<object>();
            foreach (var o in PendingOrders) pend.Add(Ord(o));
            d["pendingOrders"] = pend;
            return d;
        }

        private static Dictionary<string, object> Pos(Position p) => p == null ? null : new Dictionary<string, object>
        {
            ["id"] = p.Id, ["symbol"] = p.SymbolName, ["side"] = p.TradeType.ToString(),
            ["volumeInUnits"] = p.VolumeInUnits, ["entryTime"] = Iso(p.EntryTime), ["entryPrice"] = p.EntryPrice,
            ["stopLoss"] = p.StopLoss, ["takeProfit"] = p.TakeProfit,
            ["grossProfit"] = p.GrossProfit, ["swap"] = p.Swap, ["commissions"] = p.Commissions, ["netProfit"] = p.NetProfit,
            ["label"] = p.Label, ["comment"] = p.Comment,
        };

        private static Dictionary<string, object> Ord(PendingOrder o) => o == null ? null : new Dictionary<string, object>
        {
            ["id"] = o.Id, ["symbol"] = o.SymbolName, ["side"] = o.TradeType.ToString(), ["orderType"] = o.OrderType.ToString(),
            ["volumeInUnits"] = o.VolumeInUnits, ["targetPrice"] = o.TargetPrice,
            ["stopLoss"] = o.StopLoss, ["takeProfit"] = o.TakeProfit,
            ["submittedTime"] = Iso(o.SubmittedTime), ["expirationTime"] = IsoN(o.ExpirationTime),
            ["label"] = o.Label, ["comment"] = o.Comment,
        };

        private static string Iso(DateTime t) => t.ToUniversalTime().ToString("o");
        private static string IsoN(DateTime? t) => t.HasValue ? Iso(t.Value) : null;

        private void Send(string type, object data)
        {
            try
            {
                var body = JsonSerializer.Serialize(new Dictionary<string, object>
                {
                    ["type"] = type, ["runId"] = _runId, ["seq"] = ++_seq, ["sentAt"] = Iso(Server.TimeInUtc), ["data"] = data,
                });
                var request = new HttpRequest(new Uri(Endpoint)) { Method = HttpMethod.Post, Body = body };
                request.Headers.Add("Content-Type", "application/json");
                var response = Http.Send(request);
                if (!response.IsSuccessful) Print("FJ probe plugin – příjemce neodpověděl ({0})", response.StatusCode);
            }
            catch (Exception ex)
            {
                Print("FJ probe plugin – odeslání selhalo: {0}", ex.Message);
            }
        }
    }
}
