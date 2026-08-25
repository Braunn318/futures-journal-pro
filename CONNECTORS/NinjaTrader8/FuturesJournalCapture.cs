#region Using declarations
using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Globalization;
using System.Timers;
using NinjaTrader.Cbi;
using NinjaTrader.NinjaScript;
#endregion

// Futures Journal PRO – NinjaTrader 8 Execution + Position Sync Connector
// Exekuce se posílají okamžitě. Úplný stav pozic se posílá při každé změně
// a navíc jednou za minutu jako kontrola proti zůstatkovým/neplatným pozicím.

namespace NinjaTrader.NinjaScript.AddOns
{
    public class FuturesJournalCapture : AddOnBase
    {
        private const string ENDPOINT = "http://127.0.0.1:17654/api/v1/events";
        private const string API_KEY = "SEM_VLOZ_API_KLIC_Z_APLIKACE";
        private static readonly HttpClient Client = new HttpClient();
        private Timer syncTimer;
        // NinjaTrader umí znovu vyvolat ExecutionUpdate pro fill, který už jednou
        // proběhl – typicky po výpadku a obnovení spojení s brokerem/simulátorem.
        // Bez téhle pojistky se stejná exekuce pošle znovu a v deníku se objeví
        // jako duplicitní cíl (např. TP3 navíc u pozice se dvěma kontrakty).
        private readonly HashSet<string> sentExecutionIds = new HashSet<string>();

        protected override void OnStateChange()
        {
            if (State == State.Active)
            {
                foreach (Account account in Account.All) Subscribe(account);
                Account.AccountStatusUpdate += OnAccountStatusUpdate;

                syncTimer = new Timer(60000);
                syncTimer.AutoReset = true;
                syncTimer.Elapsed += OnSyncTimer;
                syncTimer.Start();

                SendAllPositionSnapshots();
            }
            else if (State == State.Terminated)
            {
                Account.AccountStatusUpdate -= OnAccountStatusUpdate;
                foreach (Account account in Account.All) Unsubscribe(account);
                if (syncTimer != null)
                {
                    syncTimer.Stop();
                    syncTimer.Elapsed -= OnSyncTimer;
                    syncTimer.Dispose();
                    syncTimer = null;
                }
            }
        }

        private void OnAccountStatusUpdate(object sender, AccountStatusEventArgs e)
        {
            if (e.Account != null)
            {
                Subscribe(e.Account);
                SendPositionSnapshot(e.Account);
            }
        }

        private void Subscribe(Account account)
        {
            account.ExecutionUpdate -= OnExecutionUpdate;
            account.ExecutionUpdate += OnExecutionUpdate;
            account.PositionUpdate -= OnPositionUpdate;
            account.PositionUpdate += OnPositionUpdate;
        }

        private void Unsubscribe(Account account)
        {
            account.ExecutionUpdate -= OnExecutionUpdate;
            account.PositionUpdate -= OnPositionUpdate;
        }

        private void OnSyncTimer(object sender, ElapsedEventArgs e)
        {
            SendAllPositionSnapshots();
        }

        private void OnPositionUpdate(object sender, PositionEventArgs e)
        {
            Account account = sender as Account;
            if (account != null) SendPositionSnapshot(account);
        }

        private void SendAllPositionSnapshots()
        {
            try
            {
                foreach (Account account in Account.All) SendPositionSnapshot(account);
            }
            catch (Exception ex)
            {
                Print("FuturesJournalCapture position sync error: " + ex.Message);
            }
        }

        private async void SendPositionSnapshot(Account account)
        {
            try
            {
                if (account == null) return;
                StringBuilder positions = new StringBuilder();
                positions.Append("[");
                bool first = true;
                foreach (Position p in account.Positions)
                {
                    if (p == null || p.Instrument == null || p.Quantity == 0 || p.MarketPosition == MarketPosition.Flat) continue;
                    if (!first) positions.Append(",");
                    first = false;
                    string instrument = p.Instrument.MasterInstrument != null ? p.Instrument.MasterInstrument.Name : p.Instrument.FullName;
                    string instrumentFull = p.Instrument.FullName ?? instrument;
                    double pointValue = p.Instrument.MasterInstrument != null ? p.Instrument.MasterInstrument.PointValue : 1.0;
                    positions.Append("{")
                        .Append("\"instrument\":\"").Append(Escape(instrument)).Append("\",")
                        .Append("\"instrumentFull\":\"").Append(Escape(instrumentFull)).Append("\",")
                        .Append("\"quantity\":").Append(Math.Abs(p.Quantity)).Append(",")
                        .Append("\"avgPrice\":").Append(p.AveragePrice.ToString(CultureInfo.InvariantCulture)).Append(",")
                        .Append("\"marketPosition\":\"").Append(p.MarketPosition).Append("\",")
                        .Append("\"pointValue\":").Append(pointValue.ToString(CultureInfo.InvariantCulture))
                        .Append("}");
                }
                positions.Append("]");

                string json = "{" +
                    "\"source\":\"ninjatrader\"," +
                    "\"type\":\"position_snapshot\"," +
                    "\"account\":\"" + Escape(account.Name) + "\"," +
                    "\"time\":\"" + DateTime.UtcNow.ToString("o") + "\"," +
                    "\"positions\":" + positions.ToString() +
                "}";
                await PostJson(json);
            }
            catch (Exception ex)
            {
                Print("FuturesJournalCapture snapshot error: " + ex.Message);
            }
        }

        private async void OnExecutionUpdate(object sender, ExecutionEventArgs e)
        {
            try
            {
                Execution x = e.Execution;
                if (x == null || x.Instrument == null) return;

                // Pojistka proti opakovanému odeslání téže exekuce (viz komentář u
                // sentExecutionIds výše). Pokud NinjaTrader nemá pro exekuci ID,
                // dedup se přeskočí – to je vzácné a lepší poslat než ztratit obchod.
                if (!string.IsNullOrEmpty(x.ExecutionId) && !sentExecutionIds.Add(x.ExecutionId))
                {
                    Print("FuturesJournalCapture: přeskočena opakovaně nahlášená exekuce " + x.ExecutionId);
                    return;
                }

                string account = x.Account != null ? x.Account.Name : "";
                string instrument = x.Instrument.MasterInstrument != null ? x.Instrument.MasterInstrument.Name : x.Instrument.FullName;
                string instrumentFull = x.Instrument.FullName ?? instrument;
                string action = x.Order != null ? x.Order.OrderAction.ToString() : "";
                string orderName = x.Order != null ? x.Order.Name : x.Name;
                string orderId = x.Order != null ? x.Order.OrderId : x.OrderId;
                double pointValue = x.Instrument.MasterInstrument != null ? x.Instrument.MasterInstrument.PointValue : 1.0;

                string json = "{" +
                    "\"source\":\"ninjatrader\"," +
                    "\"type\":\"execution\"," +
                    "\"account\":\"" + Escape(account) + "\"," +
                    "\"instrument\":\"" + Escape(instrument) + "\"," +
                    "\"instrumentFull\":\"" + Escape(instrumentFull) + "\"," +
                    "\"time\":\"" + x.Time.ToUniversalTime().ToString("o") + "\"," +
                    "\"price\":" + x.Price.ToString(CultureInfo.InvariantCulture) + "," +
                    "\"quantity\":" + x.Quantity + "," +
                    "\"commission\":" + x.Commission.ToString(CultureInfo.InvariantCulture) + "," +
                    "\"rate\":" + x.Rate.ToString(CultureInfo.InvariantCulture) + "," +
                    "\"pointValue\":" + pointValue.ToString(CultureInfo.InvariantCulture) + "," +
                    "\"positionAfter\":" + x.Position + "," +
                    "\"marketPosition\":\"" + x.MarketPosition + "\"," +
                    "\"orderAction\":\"" + Escape(action) + "\"," +
                    "\"orderName\":\"" + Escape(orderName) + "\"," +
                    "\"orderId\":\"" + Escape(orderId) + "\"," +
                    "\"executionId\":\"" + Escape(x.ExecutionId) + "\"" +
                "}";

                await PostJson(json);
                if (x.Account != null) SendPositionSnapshot(x.Account);
            }
            catch (Exception ex)
            {
                Print("FuturesJournalCapture error: " + ex.Message);
            }
        }

        private static async System.Threading.Tasks.Task PostJson(string json)
        {
            using (var request = new HttpRequestMessage(HttpMethod.Post, ENDPOINT))
            {
                request.Headers.Add("X-FJ-API-Key", API_KEY);
                request.Content = new StringContent(json, Encoding.UTF8, "application/json");
                HttpResponseMessage response = await Client.SendAsync(request);
                if (!response.IsSuccessStatusCode)
                    NinjaTrader.Code.Output.Process("FuturesJournalCapture HTTP " + (int)response.StatusCode, PrintTo.OutputTab1);
            }
        }

        private static string Escape(string value)
        {
            return (value ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"");
        }
    }
}
