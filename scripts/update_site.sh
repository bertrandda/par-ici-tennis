#!/bin/bash

# --- CONFIGURATION ---
WWW_DIR="/home/maxencebrunet06/www"
OUTPUT="$WWW_DIR/index.html"
LOG_FILE="/home/maxencebrunet06/tennis.log"
CONFIG_FILE="/home/maxencebrunet06/par-ici-tennis/config.json"
DATE=$(date "+%d/%m/%Y à %H:%M")

# --- ANALYSE DES DONNÉES ---
COURTS=$(jq -r 'if (.locations | type) == "array" then .locations | join(", ") else .locations | keys | join(", ") end' $CONFIG_FILE)

# --- DÉTERMINATION DU STATUT ---
STATUS="En attente"
COLOR_BG="#f2f2f7"
COLOR_TXT="#1c1c1e"
ICON="💤"

if [ -s "$LOG_FILE" ]; then
    if grep -q "Réservation faite" "$LOG_FILE"; then
        STATUS="RÉSERVÉ !"
        COLOR_BG="#34c759"
        COLOR_TXT="#ffffff"
        ICON="🎾"
    elif grep -q "Aucun créneau" "$LOG_FILE"; then
        STATUS="Aucun créneau"
        COLOR_BG="#ff9500"
        COLOR_TXT="#ffffff"
        ICON="⚠️"
    elif grep -q "Error\|Exception" "$LOG_FILE"; then
        STATUS="Erreur"
        COLOR_BG="#ff3b30"
        COLOR_TXT="#ffffff"
        ICON="❌"
    fi
else
    STATUS="Prêt"
fi

# --- GÉNÉRATION HTML ---
cat <<EOF > $OUTPUT
<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Tennis Dashboard</title>
    <style>
        :root { --bg-color: #f2f2f7; --card-bg: #ffffff; --text-main: #000000; --text-sec: #8e8e93; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: var(--bg-color); margin: 0; padding: 20px; display: flex; justify-content: center; color: var(--text-main); -webkit-font-smoothing: antialiased; }
        .container { width: 100%; max-width: 500px; display: flex; flex-direction: column; gap: 15px; }

        .header { text-align: center; margin-bottom: 10px; }
        .header h1 { margin: 0; font-size: 22px; font-weight: 700; }
        .header p { margin: 5px 0 0; color: var(--text-sec); font-size: 13px; }

        .status-card { background-color: $COLOR_BG; color: $COLOR_TXT; padding: 30px; border-radius: 22px; text-align: center; box-shadow: 0 8px 20px rgba(0,0,0,0.12); }
        .status-icon { font-size: 40px; margin-bottom: 10px; display: block; }
        .status-text { font-size: 28px; font-weight: 800; margin: 0; letter-spacing: -0.5px; }
        .status-sub { opacity: 0.9; font-size: 14px; margin-top: 5px; font-weight: 500; }

        .card { background: var(--card-bg); padding: 15px; border-radius: 18px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); }
        .card-label { font-size: 11px; text-transform: uppercase; color: var(--text-sec); font-weight: 600; margin-bottom: 5px; letter-spacing: 0.5px; }
        .card-value { font-size: 15px; font-weight: 600; overflow-wrap: break-word; }

        .logs-container { background: #1c1c1e; border-radius: 18px; padding: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
        .logs-title { color: #8e8e93; font-size: 12px; font-weight: 600; margin-bottom: 10px; text-transform: uppercase; display: flex; justify-content: space-between; }
        .logs-content { font-family: "SF Mono", "Menlo", monospace; font-size: 11px; color: #32d74b; white-space: pre-wrap; line-height: 1.4; max-height: 300px; overflow-y: auto; }

        .footer { text-align: center; margin-top: 20px; font-size: 11px; color: #c7c7cc; }
    </style>
</head>
<body>

<div class="container">
    <div class="header">
        <h1>Mon Tennis Bot</h1>
        <p>Mise à jour : $DATE</p>
    </div>

    <div class="status-card">
        <span class="status-icon">$ICON</span>
        <h2 class="status-text">$STATUS</h2>
        <div class="status-sub">Prochain tir : Demain 07:55</div>
    </div>

    <div class="card">
        <div class="card-label">Terrains surveillés</div>
        <div class="card-value">$COURTS</div>
    </div>

    <div class="card">
        <div class="card-label">Serveur</div>
        <div class="card-value">En ligne 🟢</div>
    </div>

    <div class="logs-container">
        <div class="logs-title">
            <span>TERMINAL</span>
            <span>LIVE</span>
        </div>
        <div class="logs-content">$(if [ -s "$LOG_FILE" ]; then tail -n 25 $LOG_FILE | sed 's/</\&lt;/g; s/>/\&gt;/g'; else echo "En attente du prochain lancement..."; fi)</div>
    </div>

    <div class="footer">
        Propulsé par Google Cloud & Docker
    </div>
</div>

</body>
</html>
EOF
