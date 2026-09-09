# SYSGLAS — Hardware Monitor Widget

Um widget de monitoramento de hardware ultra-leve, elegante e com design glassmorphism para desktop (estilo iStat Menus / Rainmeter / Windows 11 Flyouts).
Baseado em Electron, com telemetria nativa de alta performance e suporte a GPU dedicada NVIDIA.

![SYSGLAS](assets/tray-icon@2x.png)

## Como Executar

```bash
cd sysglas-app
npm install        # instala electron + chart.js + systeminformation
npm start          # inicia o widget de monitoramento
```

## Características do Widget

- **Formato Widget Compacto (380×600px):** Perfeito para fixar no canto da tela acima da bandeja do sistema (tray) sem poluir a área de trabalho.
- **Carregamento Instantâneo:** Inicialização e primeiro snapshot em menos de 100ms, com biblioteca `Chart.js` embutida offline.
- **Telemetria de Sub-Milisegundo:**
  - **CPU:** Cálculo delta direto via `os.cpus()` nativo do Node.js (< 0.05ms) com histórico em sparkline.
  - **GPU Dedicada (NVIDIA):** Leitura direta via `nvidia-smi` (uso, temperatura, VRAM usada/total, potência em Watts).
  - **RAM & Disco:** Consumo em GB e percentual atualizados sem travamentos.
  - **Rede ao Vivo:** Taxas de download e upload calculadas por delta do `netstat -e` com gráfico de fluxo.
- **Zero Overhead:** Consumo de CPU inferior a 1%, sem scripts lentos de PowerShell ou acúmulo de processos órfãos.
- **Controles Integrados no Widget:**
  - Botão de alternância rápida de temas (Neon Blue, Cyberpunk, Orange Flame, Ice White).
  - Botão de fixação no topo (Always on Top).
  - Botão de recolher para a bandeja do sistema.
  - Arraste livre pela barra de título.

## Menu da Bandeja (System Tray)

| Item | Ação |
|---|---|
| **Exibir / Ocultar Widget** | Alterna visibilidade do widget |
| **Tema** | Neon Blue · Cyberpunk · Orange Flame · Ice White |
| **Fixar no Topo** | Mantém o widget sobre outras janelas |
| **Iniciar com o Windows** | Auto-início na inicialização do Windows |
| **Resetar Posição** | Reposiciona o widget no canto da tela |
| **Abrir Arquivo de Configuração** | Revela o arquivo `%APPDATA%\sysglas\config.json` |
| **Sobre o SYSGLAS** | Informações de versão e ambiente |
| **Sair do SYSGLAS** | Encerra completamente o aplicativo |