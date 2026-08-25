// Futures Journal PRO – cTrader konektor
//
// Co dělá: Poslouchá na otevření a uzavření pozic (Positions.Opened / Positions.Closed)
// a každou událost odešle na lokální HTTP endpoint Futures Journal PRO – stejný,
// který používá i konektor pro NinjaTrader 8. Aplikace poté obchod automaticky
// zařadí do fronty k importu, včetně screenshotu.
//
// Multi-target pozice (TP1/TP2/Break Even): cTrader u částečných uzávěrů zachovává
// stejné Position.Id napříč všemi částmi. Konektor ho posílá jako "positionId"
// (s prefixem "ctrader-"), takže funkce slučování obchodů v aplikaci (stejná jako
// u NinjaTraderu) je dokáže spojit do jednoho obchodu automaticky.
//
// Instalace (ověřený postup): V cTraderu vlevo dole klikni Algo, v kartě cBots
// klikni New, zvol C# a "From scratch", pojmenuj přesně "FuturesJournalCTraderConnector"
// a potvrď Create. V otevřeném editoru smaž ukázkový kód a vlož místo něj celý
// obsah TOHOTO souboru. Klikni Build (Ctrl+B). Pak na grafu účtu, který chceš
// sledovat, přidej instanci tohoto cBota a klikni Start.
//
// Používá vestavěné síťové rozhraní cAlgo (Http.Send), ne System.Net.Http –
// díky tomu stačí AccessRights.None a cTrader se při spuštění na nic neptá.

using System;
using System.Globalization;
using cAlgo.API;

namespace cAlgo.Robots
{
    [Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
    public class FuturesJournalCTraderConnector : Robot
    {
        private const string ENDPOINT = "http://127.0.0.1:17654/api/v1/events";
        private const string API_KEY = "SEM_VLOZ_API_KLIC_Z_APLIKACE";

        [Parameter("Endpoint", DefaultValue = ENDPOINT)]
        public string EndpointUrl { get; set; }

        [Parameter("API klíč", DefaultValue = API_KEY)]
        public string ApiKey { get; set; }

        protected override void OnStart()
        {
            Positions.Opened += OnPositionOpened;
            Positions.Closed += OnPositionClosed;
            Print("Futures Journal PRO – konektor spuštěn pro účet {0}.", Account.Number);
        }

        private void OnPositionOpened(PositionOpenedEventArgs args)
        {
            var p = args.Position;
            var json = BuildJson(new[]
            {
                Field("type", "ctrader_position_opened"),
                Field("account", Account.Number.ToString()),
                Field("instrument", p.SymbolName),
                Field("instrumentFull", p.SymbolName),
                Field("side", p.TradeType == TradeType.Buy ? "long" : "short"),
                Field("entryTime", p.EntryTime.ToUniversalTime().ToString("o")),
                FieldNumber("entryPrice", p.EntryPrice),
                FieldNumber("quantity", p.VolumeInUnits),
                Field("positionId", "ctrader-" + p.Id),
                Field("strategy", p.Label ?? "")
            });
            Send(json);
        }

        private void OnPositionClosed(PositionClosedEventArgs args)
        {
            var p = args.Position;
            // Najdi poslední uzavírací obchod z historie odpovídající této pozici –
            // obsahuje přesná data JEN pro tuto konkrétní (i částečnou) uzávěrku.
            HistoricalTrade trade = null;
            foreach (var t in History)
            {
                if (t.PositionId == p.Id)
                {
                    if (trade == null || t.ClosingTime > trade.ClosingTime) trade = t;
                }
            }
            if (trade == null)
            {
                Print("Futures Journal PRO – uzavření pozice {0} nenalezeno v historii, přeskakuji.", p.Id);
                return;
            }

            var json = BuildJson(new[]
            {
                Field("type", "ctrader_trade_closed"),
                Field("account", Account.Number.ToString()),
                Field("instrument", trade.SymbolName),
                Field("instrumentFull", trade.SymbolName),
                Field("side", trade.TradeType == TradeType.Buy ? "long" : "short"),
                Field("entryTime", trade.EntryTime.ToUniversalTime().ToString("o")),
                FieldNumber("entryPrice", trade.EntryPrice),
                Field("exitTime", trade.ClosingTime.ToUniversalTime().ToString("o")),
                FieldNumber("exitPrice", trade.ClosingPrice),
                FieldNumber("quantity", trade.VolumeInUnits),
                FieldNumber("points", trade.Pips),
                FieldNumber("pnl", trade.NetProfit),
                FieldNumber("commission", trade.Commissions),
                FieldNumber("swap", trade.Swap),
                Field("positionId", "ctrader-" + p.Id),
                Field("closingDealId", trade.ClosingDealId.ToString()),
                Field("strategy", trade.Label ?? "")
            });
            Send(json);
        }

        private void Send(string json)
        {
            var url = string.IsNullOrWhiteSpace(EndpointUrl) ? ENDPOINT : EndpointUrl;
            var key = string.IsNullOrWhiteSpace(ApiKey) ? API_KEY : ApiKey;
            try
            {
                var request = new HttpRequest(new Uri(url));
                request.Method = HttpMethod.Post;
                request.Headers.Add("X-FJ-API-Key", key);
                request.Headers.Add("X-FJ-Source", "ctrader");
                request.Headers.Add("Content-Type", "application/json");
                request.Body = json;
                var response = Http.Send(request);
                if (!response.IsSuccessful)
                    Print("Futures Journal PRO – server odpověděl chybou. Odpověď: {0}", response.Body);
            }
            catch (Exception ex)
            {
                Print("Futures Journal PRO – odeslání se nezdařilo (běží aplikace?): {0}", ex.Message);
            }
        }

        // Jednoduché ruční sestavení JSON (bez závislosti na Newtonsoft.Json).
        private static string Field(string key, string value)
        {
            return "\"" + key + "\":\"" + Escape(value ?? "") + "\"";
        }
        private static string FieldNumber(string key, double value)
        {
            return "\"" + key + "\":" + value.ToString(CultureInfo.InvariantCulture);
        }
        private static string BuildJson(string[] fields)
        {
            return "{\"source\":\"ctrader\"," + string.Join(",", fields) + "}";
        }
        private static string Escape(string s)
        {
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", " ").Replace("\r", " ");
        }
    }
}
