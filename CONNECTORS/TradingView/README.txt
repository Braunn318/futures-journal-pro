TRADINGVIEW AUTOMATIZACE

1. Nasaď Cloudflare Worker ze složky ../TradingViewRelayWorker.
2. Vytvoř KV namespace a doplň jeho ID do wrangler.toml.
3. Nastav dlouhý tajný RELAY_TOKEN.
4. TradingView webhook URL:
   https://TVUJ-WORKER.workers.dev/webhook?token=TVUJ_TOKEN
5. V aplikaci Integrace nastav adresu Workeru bez /webhook:
   https://TVUJ-WORKER.workers.dev
6. Zadej stejný token a zapni relay.

TradingView alert je signál z grafu. Skutečné broker fill údaje jsou přesnější z NinjaTraderu.
