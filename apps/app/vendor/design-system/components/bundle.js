/* @ds-bundle: {"format": 4, "namespace": "Shibaox", "components": [{"name": "Button"}, {"name": "IconButton"}, {"name": "Input"}, {"name": "Switch"}, {"name": "Composer"}, {"name": "Tabs"}, {"name": "NavItem"}, {"name": "Badge"}, {"name": "AgentStatus"}, {"name": "Toast"}, {"name": "Avatar"}, {"name": "Mascot"}, {"name": "Message"}, {"name": "ToolCall"}, {"name": "ThinkingIndicator"}, {"name": "CodeBlock"}, {"name": "Card"}, {"name": "Kbd"}, {"name": "Icon"}, {"name": "Wave"}, {"name": "TextShimmer"}, {"name": "Segmented"}]} */
(function () {
  var React = window.React, h = React.createElement, useState = React.useState, useEffect = React.useEffect, useRef = React.useRef;
  var ICONS = {"download": "<path d=\"M12 15V3\"/> <path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"/> <path d=\"m7 10 5 5 5-5\"/>", "external-link": "<path d=\"M15 3h6v6\"/> <path d=\"M10 14 21 3\"/> <path d=\"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6\"/>", "table": "<path d=\"M12 3v18\"/> <rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"/> <path d=\"M3 9h18\"/> <path d=\"M3 15h18\"/>", "image": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" ry=\"2\"/> <circle cx=\"9\" cy=\"9\" r=\"2\"/> <path d=\"m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21\"/>", "code": "<path d=\"m16 18 6-6-6-6\"/> <path d=\"m8 6-6 6 6 6\"/>", "arrow-up": "<path d=\"m5 12 7-7 7 7\"/> <path d=\"M12 19V5\"/>", "brain": "<path d=\"M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z\"/> <path d=\"M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z\"/> <path d=\"M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4\"/> <path d=\"M17.599 6.5a3 3 0 0 0 .399-1.375\"/> <path d=\"M6.003 5.125A3 3 0 0 0 6.401 6.5\"/> <path d=\"M3.477 10.896a4 4 0 0 1 .585-.396\"/> <path d=\"M19.938 10.5a4 4 0 0 1 .585.396\"/> <path d=\"M6 18a4 4 0 0 1-1.967-.516\"/> <path d=\"M19.967 17.484A4 4 0 0 1 18 18\"/>", "check": "<path d=\"M20 6 9 17l-5-5\"/>", "chevron-down": "<path d=\"m6 9 6 6 6-6\"/>", "chevron-right": "<path d=\"m9 18 6-6-6-6\"/>", "clock": "<circle cx=\"12\" cy=\"12\" r=\"10\"/> <polyline points=\"12 6 12 12 16 14\"/>", "copy": "<rect width=\"14\" height=\"14\" x=\"8\" y=\"8\" rx=\"2\" ry=\"2\"/> <path d=\"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\"/>", "file-text": "<path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\"/> <path d=\"M14 2v4a2 2 0 0 0 2 2h4\"/> <path d=\"M10 9H8\"/> <path d=\"M16 13H8\"/> <path d=\"M16 17H8\"/>", "folder": "<path d=\"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z\"/>", "globe": "<circle cx=\"12\" cy=\"12\" r=\"10\"/> <path d=\"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20\"/> <path d=\"M2 12h20\"/>", "history": "<path d=\"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8\"/> <path d=\"M3 3v5h5\"/> <path d=\"M12 7v5l4 2\"/>", "info": "<circle cx=\"12\" cy=\"12\" r=\"10\"/> <path d=\"M12 16v-4\"/> <path d=\"M12 8h.01\"/>", "message-square": "<path d=\"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z\"/>", "mic": "<path d=\"M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z\"/> <path d=\"M19 10v2a7 7 0 0 1-14 0v-2\"/> <line x1=\"12\" x2=\"12\" y1=\"19\" y2=\"22\"/>", "paperclip": "<path d=\"m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48\"/>", "play": "<polygon points=\"6 3 20 12 6 21 6 3\"/>", "plug": "<path d=\"M12 22v-5\"/> <path d=\"M9 8V2\"/> <path d=\"M15 8V2\"/> <path d=\"M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z\"/>", "plus": "<path d=\"M5 12h14\"/> <path d=\"M12 5v14\"/>", "search": "<circle cx=\"11\" cy=\"11\" r=\"8\"/> <path d=\"m21 21-4.3-4.3\"/>", "send-horizontal": "<path d=\"M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z\"/> <path d=\"M6 12h16\"/>", "settings": "<path d=\"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z\"/> <circle cx=\"12\" cy=\"12\" r=\"3\"/>", "square": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"/>", "terminal": "<polyline points=\"4 17 10 11 4 5\"/> <line x1=\"12\" x2=\"20\" y1=\"19\" y2=\"19\"/>", "triangle-alert": "<path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\"/> <path d=\"M12 9v4\"/> <path d=\"M12 17h.01\"/>", "wrench": "<path d=\"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z\"/>", "x": "<path d=\"M18 6 6 18\"/> <path d=\"m6 6 12 12\"/>", "zap": "<path d=\"M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z\"/>", "puzzle": "<path d=\"M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z\"/>", "key": "<path d=\"m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4\"/> <path d=\"m21 2-9.6 9.6\"/> <circle cx=\"7.5\" cy=\"15.5\" r=\"5.5\"/>", "lock": "<rect width=\"18\" height=\"11\" x=\"3\" y=\"11\" rx=\"2\" ry=\"2\"/> <path d=\"M7 11V7a5 5 0 0 1 10 0v4\"/>", "package": "<path d=\"M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z\"/> <path d=\"M12 22V12\"/> <path d=\"m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7\"/> <path d=\"m7.5 4.27 9 5.15\"/>", "trash": "<path d=\"M3 6h18\"/> <path d=\"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6\"/> <path d=\"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2\"/>", "sparkles": "<path d=\"M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z\"/> <path d=\"M20 3v4\"/> <path d=\"M22 5h-4\"/> <path d=\"M4 17v2\"/> <path d=\"M5 18H3\"/>", "server": "<rect width=\"20\" height=\"8\" x=\"2\" y=\"2\" rx=\"2\" ry=\"2\"/> <rect width=\"20\" height=\"8\" x=\"2\" y=\"14\" rx=\"2\" ry=\"2\"/> <line x1=\"6\" x2=\"6.01\" y1=\"6\" y2=\"6\"/> <line x1=\"6\" x2=\"6.01\" y1=\"18\" y2=\"18\"/>", "github": "<path d=\"M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4\"/> <path d=\"M9 18c-4.51 2-5-2-7-2\"/>", "filter": "<polygon points=\"22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3\"/>", "more-horizontal": "<circle cx=\"12\" cy=\"12\" r=\"1\"/> <circle cx=\"19\" cy=\"12\" r=\"1\"/> <circle cx=\"5\" cy=\"12\" r=\"1\"/>", "arrow-up-down": "<path d=\"m21 16-4 4-4-4\"/> <path d=\"M17 20V4\"/> <path d=\"m3 8 4-4 4 4\"/> <path d=\"M7 4v16\"/>", "check-circle": "<path d=\"M21.801 10A10 10 0 1 1 17 3.335\"/> <path d=\"m9 11 3 3L22 4\"/>"};
  var MOODS = {"default": "<path d=\"M44 118 C40 86 46 52 60 30 C63 25 69 24 73 28 L116 70 Z\" fill=\"#F2842B\"/><path d=\"M58 96 C57 76 61 58 67 46 L98 78 Z\" fill=\"#FFD2AE\"/><path d=\"M196 118 C200 86 194 52 180 30 C177 25 171 24 167 28 L124 70 Z\" fill=\"#F2842B\"/><path d=\"M182 96 C183 76 179 58 173 46 L142 78 Z\" fill=\"#FFD2AE\"/><path d=\"M120 54 C160 54 188 70 198 100 C204 118 214 134 222 150 C226 158 222 164 214 168 C196 196 162 212 120 212 C78 212 44 196 26 168 C18 164 14 158 18 150 C26 134 36 118 42 100 C52 70 80 54 120 54 Z\" fill=\"#F2842B\"/><path d=\"M74 64 C88 57 104 54 120 54 C136 54 152 57 166 64 C150 70 136 80 128 94 C125 99 122 100 120 100 C118 100 115 99 112 94 C104 80 90 70 74 64 Z\" fill=\"#DB6716\"/><clipPath id=\"__ID__\"><path d=\"M120 54 C160 54 188 70 198 100 C204 118 214 134 222 150 C226 158 222 164 214 168 C196 196 162 212 120 212 C78 212 44 196 26 168 C18 164 14 158 18 150 C26 134 36 118 42 100 C52 70 80 54 120 54 Z\"/><\/clipPath><path d=\"M22 156 C40 150 62 146 80 142 C96 139 106 128 112 110 C115 102 118 98 120 98 C122 98 125 102 128 110 C134 128 144 139 160 142 C178 146 200 150 218 156 C224 170 226 200 200 220 L40 220 C14 200 16 170 22 156 Z\" fill=\"#FFF3E3\" clip-path=\"url(#__ID__)\"/><ellipse cx=\"88\" cy=\"101\" rx=\"7.5\" ry=\"5.5\" fill=\"#FFF3E3\"/><ellipse cx=\"152\" cy=\"101\" rx=\"7.5\" ry=\"5.5\" fill=\"#FFF3E3\"/><ellipse cx=\"90\" cy=\"122\" rx=\"8.5\" ry=\"10.5\" fill=\"#20160F\"/><ellipse cx=\"150\" cy=\"122\" rx=\"8.5\" ry=\"10.5\" fill=\"#20160F\"/><circle cx=\"93\" cy=\"118\" r=\"3\" fill=\"#FFFFFF\"/><circle cx=\"153\" cy=\"118\" r=\"3\" fill=\"#FFFFFF\"/><ellipse cx=\"66\" cy=\"148\" rx=\"11\" ry=\"6.5\" fill=\"#FF9E73\" opacity=\".55\"/><ellipse cx=\"174\" cy=\"148\" rx=\"11\" ry=\"6.5\" fill=\"#FF9E73\" opacity=\".55\"/><path d=\"M109 146 C109 141 131 141 131 146 C131 152 124 157 120 157 C116 157 109 152 109 146 Z\" fill=\"#20160F\"/><ellipse cx=\"116\" cy=\"145\" rx=\"3.5\" ry=\"2\" fill=\"#5a4436\"/><path d=\"M120 157 L120 163 M104 162 Q112 172 120 163 Q128 172 136 162\" fill=\"none\" stroke=\"#20160F\" stroke-width=\"4.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>", "happy": "<path d=\"M44 118 C40 86 46 52 60 30 C63 25 69 24 73 28 L116 70 Z\" fill=\"#F2842B\"/><path d=\"M58 96 C57 76 61 58 67 46 L98 78 Z\" fill=\"#FFD2AE\"/><path d=\"M196 118 C200 86 194 52 180 30 C177 25 171 24 167 28 L124 70 Z\" fill=\"#F2842B\"/><path d=\"M182 96 C183 76 179 58 173 46 L142 78 Z\" fill=\"#FFD2AE\"/><path d=\"M120 54 C160 54 188 70 198 100 C204 118 214 134 222 150 C226 158 222 164 214 168 C196 196 162 212 120 212 C78 212 44 196 26 168 C18 164 14 158 18 150 C26 134 36 118 42 100 C52 70 80 54 120 54 Z\" fill=\"#F2842B\"/><path d=\"M74 64 C88 57 104 54 120 54 C136 54 152 57 166 64 C150 70 136 80 128 94 C125 99 122 100 120 100 C118 100 115 99 112 94 C104 80 90 70 74 64 Z\" fill=\"#DB6716\"/><clipPath id=\"__ID__\"><path d=\"M120 54 C160 54 188 70 198 100 C204 118 214 134 222 150 C226 158 222 164 214 168 C196 196 162 212 120 212 C78 212 44 196 26 168 C18 164 14 158 18 150 C26 134 36 118 42 100 C52 70 80 54 120 54 Z\"/><\/clipPath><path d=\"M22 156 C40 150 62 146 80 142 C96 139 106 128 112 110 C115 102 118 98 120 98 C122 98 125 102 128 110 C134 128 144 139 160 142 C178 146 200 150 218 156 C224 170 226 200 200 220 L40 220 C14 200 16 170 22 156 Z\" fill=\"#FFF3E3\" clip-path=\"url(#__ID__)\"/><ellipse cx=\"88\" cy=\"101\" rx=\"7.5\" ry=\"5.5\" fill=\"#FFF3E3\"/><ellipse cx=\"152\" cy=\"101\" rx=\"7.5\" ry=\"5.5\" fill=\"#FFF3E3\"/><path d=\"M80 126 Q90 112 100 126\" fill=\"none\" stroke=\"#20160F\" stroke-width=\"6\" stroke-linecap=\"round\"/><path d=\"M140 126 Q150 112 160 126\" fill=\"none\" stroke=\"#20160F\" stroke-width=\"6\" stroke-linecap=\"round\"/><ellipse cx=\"66\" cy=\"148\" rx=\"11\" ry=\"6.5\" fill=\"#FF9E73\" opacity=\".55\"/><ellipse cx=\"174\" cy=\"148\" rx=\"11\" ry=\"6.5\" fill=\"#FF9E73\" opacity=\".55\"/><path d=\"M109 146 C109 141 131 141 131 146 C131 152 124 157 120 157 C116 157 109 152 109 146 Z\" fill=\"#20160F\"/><ellipse cx=\"116\" cy=\"145\" rx=\"3.5\" ry=\"2\" fill=\"#5a4436\"/><path d=\"M104 162 Q112 170 120 163 Q128 170 136 162 Q134 184 120 186 Q106 184 104 162 Z\" fill=\"#20160F\" stroke=\"#20160F\" stroke-width=\"4\" stroke-linejoin=\"round\"/><path d=\"M110 176 Q120 168 130 176 Q126 184 120 184 Q114 184 110 176 Z\" fill=\"#FF7A6B\"/>", "thinking": "<path d=\"M44 118 C40 86 46 52 60 30 C63 25 69 24 73 28 L116 70 Z\" fill=\"#F2842B\"/><path d=\"M58 96 C57 76 61 58 67 46 L98 78 Z\" fill=\"#FFD2AE\"/><path d=\"M196 118 C200 86 194 52 180 30 C177 25 171 24 167 28 L124 70 Z\" fill=\"#F2842B\"/><path d=\"M182 96 C183 76 179 58 173 46 L142 78 Z\" fill=\"#FFD2AE\"/><path d=\"M120 54 C160 54 188 70 198 100 C204 118 214 134 222 150 C226 158 222 164 214 168 C196 196 162 212 120 212 C78 212 44 196 26 168 C18 164 14 158 18 150 C26 134 36 118 42 100 C52 70 80 54 120 54 Z\" fill=\"#F2842B\"/><path d=\"M74 64 C88 57 104 54 120 54 C136 54 152 57 166 64 C150 70 136 80 128 94 C125 99 122 100 120 100 C118 100 115 99 112 94 C104 80 90 70 74 64 Z\" fill=\"#DB6716\"/><clipPath id=\"__ID__\"><path d=\"M120 54 C160 54 188 70 198 100 C204 118 214 134 222 150 C226 158 222 164 214 168 C196 196 162 212 120 212 C78 212 44 196 26 168 C18 164 14 158 18 150 C26 134 36 118 42 100 C52 70 80 54 120 54 Z\"/><\/clipPath><path d=\"M22 156 C40 150 62 146 80 142 C96 139 106 128 112 110 C115 102 118 98 120 98 C122 98 125 102 128 110 C134 128 144 139 160 142 C178 146 200 150 218 156 C224 170 226 200 200 220 L40 220 C14 200 16 170 22 156 Z\" fill=\"#FFF3E3\" clip-path=\"url(#__ID__)\"/><ellipse cx=\"88\" cy=\"96\" rx=\"7.5\" ry=\"5.5\" fill=\"#FFF3E3\"/><ellipse cx=\"152\" cy=\"96\" rx=\"7.5\" ry=\"5.5\" fill=\"#FFF3E3\"/><ellipse cx=\"92\" cy=\"118\" rx=\"8.5\" ry=\"10.5\" fill=\"#20160F\"/><ellipse cx=\"152\" cy=\"118\" rx=\"8.5\" ry=\"10.5\" fill=\"#20160F\"/><circle cx=\"96\" cy=\"112\" r=\"3\" fill=\"#FFFFFF\"/><circle cx=\"156\" cy=\"112\" r=\"3\" fill=\"#FFFFFF\"/><ellipse cx=\"66\" cy=\"148\" rx=\"11\" ry=\"6.5\" fill=\"#FF9E73\" opacity=\".55\"/><ellipse cx=\"174\" cy=\"148\" rx=\"11\" ry=\"6.5\" fill=\"#FF9E73\" opacity=\".55\"/><path d=\"M109 146 C109 141 131 141 131 146 C131 152 124 157 120 157 C116 157 109 152 109 146 Z\" fill=\"#20160F\"/><ellipse cx=\"116\" cy=\"145\" rx=\"3.5\" ry=\"2\" fill=\"#5a4436\"/><path d=\"M120 157 L120 162\" stroke=\"#20160F\" stroke-width=\"4.5\" stroke-linecap=\"round\"/><ellipse cx=\"120\" cy=\"171\" rx=\"6\" ry=\"7\" fill=\"#20160F\"/>", "working": "<path d=\"M44 118 C40 86 46 52 60 30 C63 25 69 24 73 28 L116 70 Z\" fill=\"#F2842B\"/><path d=\"M58 96 C57 76 61 58 67 46 L98 78 Z\" fill=\"#FFD2AE\"/><path d=\"M196 118 C200 86 194 52 180 30 C177 25 171 24 167 28 L124 70 Z\" fill=\"#F2842B\"/><path d=\"M182 96 C183 76 179 58 173 46 L142 78 Z\" fill=\"#FFD2AE\"/><path d=\"M120 54 C160 54 188 70 198 100 C204 118 214 134 222 150 C226 158 222 164 214 168 C196 196 162 212 120 212 C78 212 44 196 26 168 C18 164 14 158 18 150 C26 134 36 118 42 100 C52 70 80 54 120 54 Z\" fill=\"#F2842B\"/><path d=\"M74 64 C88 57 104 54 120 54 C136 54 152 57 166 64 C150 70 136 80 128 94 C125 99 122 100 120 100 C118 100 115 99 112 94 C104 80 90 70 74 64 Z\" fill=\"#DB6716\"/><clipPath id=\"__ID__\"><path d=\"M120 54 C160 54 188 70 198 100 C204 118 214 134 222 150 C226 158 222 164 214 168 C196 196 162 212 120 212 C78 212 44 196 26 168 C18 164 14 158 18 150 C26 134 36 118 42 100 C52 70 80 54 120 54 Z\"/><\/clipPath><path d=\"M22 156 C40 150 62 146 80 142 C96 139 106 128 112 110 C115 102 118 98 120 98 C122 98 125 102 128 110 C134 128 144 139 160 142 C178 146 200 150 218 156 C224 170 226 200 200 220 L40 220 C14 200 16 170 22 156 Z\" fill=\"#FFF3E3\" clip-path=\"url(#__ID__)\"/><ellipse cx=\"88\" cy=\"101\" rx=\"7.5\" ry=\"5.5\" fill=\"#FFF3E3\"/><ellipse cx=\"152\" cy=\"101\" rx=\"7.5\" ry=\"5.5\" fill=\"#FFF3E3\"/><ellipse cx=\"90\" cy=\"123\" rx=\"8.5\" ry=\"8\" fill=\"#20160F\"/><ellipse cx=\"150\" cy=\"123\" rx=\"8.5\" ry=\"8\" fill=\"#20160F\"/><path d=\"M80 114 L100 117\" stroke=\"#F2842B\" stroke-width=\"7\" stroke-linecap=\"round\"/><path d=\"M160 114 L140 117\" stroke=\"#F2842B\" stroke-width=\"7\" stroke-linecap=\"round\"/><circle cx=\"93\" cy=\"120\" r=\"2.6\" fill=\"#FFFFFF\"/><circle cx=\"153\" cy=\"120\" r=\"2.6\" fill=\"#FFFFFF\"/><path d=\"M109 146 C109 141 131 141 131 146 C131 152 124 157 120 157 C116 157 109 152 109 146 Z\" fill=\"#20160F\"/><ellipse cx=\"116\" cy=\"145\" rx=\"3.5\" ry=\"2\" fill=\"#5a4436\"/><path d=\"M120 157 L120 164 M110 166 L130 166\" fill=\"none\" stroke=\"#20160F\" stroke-width=\"4.5\" stroke-linecap=\"round\"/>", "sleeping": "<path d=\"M44 118 C40 86 46 52 60 30 C63 25 69 24 73 28 L116 70 Z\" fill=\"#F2842B\"/><path d=\"M58 96 C57 76 61 58 67 46 L98 78 Z\" fill=\"#FFD2AE\"/><path d=\"M196 118 C200 86 194 52 180 30 C177 25 171 24 167 28 L124 70 Z\" fill=\"#F2842B\"/><path d=\"M182 96 C183 76 179 58 173 46 L142 78 Z\" fill=\"#FFD2AE\"/><path d=\"M120 54 C160 54 188 70 198 100 C204 118 214 134 222 150 C226 158 222 164 214 168 C196 196 162 212 120 212 C78 212 44 196 26 168 C18 164 14 158 18 150 C26 134 36 118 42 100 C52 70 80 54 120 54 Z\" fill=\"#F2842B\"/><path d=\"M74 64 C88 57 104 54 120 54 C136 54 152 57 166 64 C150 70 136 80 128 94 C125 99 122 100 120 100 C118 100 115 99 112 94 C104 80 90 70 74 64 Z\" fill=\"#DB6716\"/><clipPath id=\"__ID__\"><path d=\"M120 54 C160 54 188 70 198 100 C204 118 214 134 222 150 C226 158 222 164 214 168 C196 196 162 212 120 212 C78 212 44 196 26 168 C18 164 14 158 18 150 C26 134 36 118 42 100 C52 70 80 54 120 54 Z\"/><\/clipPath><path d=\"M22 156 C40 150 62 146 80 142 C96 139 106 128 112 110 C115 102 118 98 120 98 C122 98 125 102 128 110 C134 128 144 139 160 142 C178 146 200 150 218 156 C224 170 226 200 200 220 L40 220 C14 200 16 170 22 156 Z\" fill=\"#FFF3E3\" clip-path=\"url(#__ID__)\"/><ellipse cx=\"88\" cy=\"101\" rx=\"7.5\" ry=\"5.5\" fill=\"#FFF3E3\"/><ellipse cx=\"152\" cy=\"101\" rx=\"7.5\" ry=\"5.5\" fill=\"#FFF3E3\"/><path d=\"M80 122 Q90 130 100 122\" fill=\"none\" stroke=\"#20160F\" stroke-width=\"5\" stroke-linecap=\"round\"/><path d=\"M140 122 Q150 130 160 122\" fill=\"none\" stroke=\"#20160F\" stroke-width=\"5\" stroke-linecap=\"round\"/><ellipse cx=\"66\" cy=\"148\" rx=\"11\" ry=\"6.5\" fill=\"#FF9E73\" opacity=\".55\"/><ellipse cx=\"174\" cy=\"148\" rx=\"11\" ry=\"6.5\" fill=\"#FF9E73\" opacity=\".55\"/><path d=\"M109 146 C109 141 131 141 131 146 C131 152 124 157 120 157 C116 157 109 152 109 146 Z\" fill=\"#20160F\"/><ellipse cx=\"116\" cy=\"145\" rx=\"3.5\" ry=\"2\" fill=\"#5a4436\"/><path d=\"M120 157 L120 164 M110 166 L130 166\" fill=\"none\" stroke=\"#20160F\" stroke-width=\"4.5\" stroke-linecap=\"round\"/>", "error": "<g transform=\"rotate(-26 84 96)\"><path d=\"M44 118 C40 86 46 52 60 30 C63 25 69 24 73 28 L116 70 Z\" fill=\"#F2842B\"/><path d=\"M58 96 C57 76 61 58 67 46 L98 78 Z\" fill=\"#FFD2AE\"/><\/g><g transform=\"rotate(26 156 96)\"><path d=\"M196 118 C200 86 194 52 180 30 C177 25 171 24 167 28 L124 70 Z\" fill=\"#F2842B\"/><path d=\"M182 96 C183 76 179 58 173 46 L142 78 Z\" fill=\"#FFD2AE\"/><\/g><path d=\"M120 54 C160 54 188 70 198 100 C204 118 214 134 222 150 C226 158 222 164 214 168 C196 196 162 212 120 212 C78 212 44 196 26 168 C18 164 14 158 18 150 C26 134 36 118 42 100 C52 70 80 54 120 54 Z\" fill=\"#F2842B\"/><path d=\"M74 64 C88 57 104 54 120 54 C136 54 152 57 166 64 C150 70 136 80 128 94 C125 99 122 100 120 100 C118 100 115 99 112 94 C104 80 90 70 74 64 Z\" fill=\"#DB6716\"/><clipPath id=\"__ID__\"><path d=\"M120 54 C160 54 188 70 198 100 C204 118 214 134 222 150 C226 158 222 164 214 168 C196 196 162 212 120 212 C78 212 44 196 26 168 C18 164 14 158 18 150 C26 134 36 118 42 100 C52 70 80 54 120 54 Z\"/><\/clipPath><path d=\"M22 156 C40 150 62 146 80 142 C96 139 106 128 112 110 C115 102 118 98 120 98 C122 98 125 102 128 110 C134 128 144 139 160 142 C178 146 200 150 218 156 C224 170 226 200 200 220 L40 220 C14 200 16 170 22 156 Z\" fill=\"#FFF3E3\" clip-path=\"url(#__ID__)\"/><ellipse cx=\"86\" cy=\"100\" rx=\"8\" ry=\"5\" transform=\"rotate(-18 86 100)\" fill=\"#FFF3E3\"/><ellipse cx=\"154\" cy=\"100\" rx=\"8\" ry=\"5\" transform=\"rotate(18 154 100)\" fill=\"#FFF3E3\"/><ellipse cx=\"90\" cy=\"124\" rx=\"7.5\" ry=\"9.5\" fill=\"#20160F\"/><ellipse cx=\"150\" cy=\"124\" rx=\"7.5\" ry=\"9.5\" fill=\"#20160F\"/><circle cx=\"92\" cy=\"120\" r=\"2.6\" fill=\"#FFFFFF\"/><circle cx=\"152\" cy=\"120\" r=\"2.6\" fill=\"#FFFFFF\"/><path d=\"M109 146 C109 141 131 141 131 146 C131 152 124 157 120 157 C116 157 109 152 109 146 Z\" fill=\"#20160F\"/><ellipse cx=\"116\" cy=\"145\" rx=\"3.5\" ry=\"2\" fill=\"#5a4436\"/><path d=\"M104 168 Q108 162 112 168 Q116 174 120 168 Q124 162 128 168 Q132 174 136 168\" fill=\"none\" stroke=\"#20160F\" stroke-width=\"4.5\" stroke-linecap=\"round\"/><path d=\"M120 157 L120 162\" stroke=\"#20160F\" stroke-width=\"4.5\" stroke-linecap=\"round\"/>"};
  var uid = 0;
  function cx() { return Array.prototype.filter.call(arguments, Boolean).join(' '); }

  function Icon(p) {
    var size = p.size || 16;
    return h('svg', { className: cx('sx-icon', p.className), width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: p.strokeWidth || 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': p.label ? undefined : true, role: p.label ? 'img' : undefined, 'aria-label': p.label, dangerouslySetInnerHTML: { __html: ICONS[p.name] || '' } });
  }

  function Mascot(p) {
    var ref = React.useRef(null); if (ref.current === null) ref.current = 'sxm' + (++uid);
    var mood = MOODS[p.mood] ? p.mood : 'default';
    var size = p.size || 96;
    var extra = '';
    if (mood === 'thinking') extra = '<circle cx="200" cy="44" r="7" fill="currentColor"/><circle cx="216" cy="28" r="5" fill="currentColor" opacity=".7"/><circle cx="228" cy="16" r="3.5" fill="currentColor" opacity=".45"/>';
    if (mood === 'sleeping') extra = '<path d="M190 32 H208 L190 52 H208" fill="none" stroke="currentColor" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M214 12 H226 L214 26 H226" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity=".55"/>';
    return h('svg', { className: cx('sx-mascot', p.className), width: size, height: size, viewBox: p.crop ? '10 20 220 220' : '0 0 240 240', role: 'img', 'aria-label': p.label || ('Shiba — ' + mood), dangerouslySetInnerHTML: { __html: MOODS[mood].split('__ID__').join(ref.current) + (p.crop ? '' : extra) } });
  }

  var WAVE_BARS = ['50%', '75%', '100%', '75%', '50%'];
  function Wave(p) {
    p = p || {}; var size = p.size || 16, dur = p.duration || 1, delay = p.delay != null ? p.delay : 0.1;
    var decorative = p.decorative;
    return h('span', { className: cx('sx-wave', p.className), role: decorative ? undefined : 'status', 'aria-hidden': decorative ? true : undefined, style: Object.assign({ width: size, height: size }, p.style) },
      WAVE_BARS.map(function (ht, i) { return h('span', { key: i, 'aria-hidden': true, className: 'sx-wave__bar', style: { height: ht, animationDuration: dur + 's', animationDelay: (delay * i) + 's' } }); }),
      decorative ? null : h('span', { className: 'sx-sr' }, p.label || 'Loading'));
  }
  function TextShimmer(p) {
    var text = String(p.children == null ? '' : p.children), n = Math.max(text.length, 1);
    var dur = p.duration || 1, spread = p.spread || 1, cycle = dur * 1.6 + (n * 0.05) / spread;
    var Tag = p.as || 'span';
    return h(Tag, { className: cx('sx-shimmer', p.className), 'aria-label': text, style: p.style },
      text.split('').map(function (ch, i) {
        return h('span', { key: i, 'aria-hidden': true, className: 'sx-shimmer__c', style: { animationDuration: cycle + 's', animationDelay: ((i * dur) / spread / n) + 's' } }, ch);
      }));
  }
  function Spinner(p) { return h(Wave, { size: (p && p.size) || 14, decorative: true }); }

  function Button(p) {
    var variant = p.variant || 'secondary', size = p.size || 'md';
    var rest = Object.assign({}, p); ['variant', 'size', 'icon', 'iconRight', 'loading', 'className', 'children'].forEach(function (k) { delete rest[k]; });
    return h('button', Object.assign({ type: 'button' }, rest, { disabled: p.disabled || p.loading, 'aria-busy': p.loading || undefined, className: cx('sx-btn', 'sx-btn--' + variant, 'sx-btn--' + size, p.className) }),
      p.loading ? h(Spinner) : (p.icon ? h(Icon, { name: p.icon, size: size === 'lg' ? 18 : 16 }) : null),
      p.children ? h('span', null, p.children) : null,
      p.iconRight ? h(Icon, { name: p.iconRight, size: 16 }) : null);
  }

  function IconButton(p) {
    var rest = Object.assign({}, p); ['variant', 'size', 'icon', 'label', 'className'].forEach(function (k) { delete rest[k]; });
    return h('button', Object.assign({ type: 'button' }, rest, { 'aria-label': p.label, title: p.label, className: cx('sx-iconbtn', 'sx-btn--' + (p.variant || 'quiet'), 'sx-iconbtn--' + (p.size || 'md'), p.className) }), h(Icon, { name: p.icon, size: p.size === 'sm' ? 16 : 18 }));
  }

  function Input(p) {
    var ref = React.useRef(null); if (ref.current === null) ref.current = 'sxi' + (++uid);
    var id = p.id || ref.current;
    var rest = Object.assign({}, p); ['label', 'hint', 'error', 'icon', 'className'].forEach(function (k) { delete rest[k]; });
    return h('div', { className: cx('sx-field', p.error && 'is-error', p.className) },
      p.label ? h('label', { className: 'sx-field__label', htmlFor: id }, p.label) : null,
      h('div', { className: 'sx-field__box' }, p.icon ? h(Icon, { name: p.icon, size: 16 }) : null,
        h('input', Object.assign({ id: id, className: 'sx-field__input', 'aria-invalid': p.error ? true : undefined, 'aria-describedby': (p.error || p.hint) ? id + '-d' : undefined }, rest))),
      (p.error || p.hint) ? h('p', { id: id + '-d', className: 'sx-field__hint' }, p.error ? h(Icon, { name: 'triangle-alert', size: 14 }) : null, p.error || p.hint) : null);
  }

  function Switch(p) {
    var s = useState(!!p.defaultChecked), on = p.checked !== undefined ? p.checked : s[0];
    function toggle() { if (p.disabled) return; if (p.checked === undefined) s[1](!on); if (p.onChange) p.onChange(!on); }
    return h('label', { className: cx('sx-switch', p.disabled && 'is-disabled') },
      h('button', { type: 'button', role: 'switch', 'aria-checked': on, disabled: p.disabled, className: 'sx-switch__track', onClick: toggle }, h('span', { className: 'sx-switch__thumb' })),
      p.label ? h('span', { className: 'sx-switch__label' }, p.label) : null);
  }

  function Tabs(p) {
    var s = useState(p.defaultValue || (p.items[0] && p.items[0].id)), val = p.value !== undefined ? p.value : s[0];
    return h('div', { className: 'sx-tabs', role: 'tablist' }, p.items.map(function (it) {
      var sel = it.id === val;
      return h('button', { key: it.id, type: 'button', role: 'tab', 'aria-selected': sel, className: cx('sx-tab', sel && 'is-active'), onClick: function () { if (p.value === undefined) s[1](it.id); if (p.onChange) p.onChange(it.id); } },
        it.label, it.count != null ? h('span', { className: 'sx-tab__count' }, it.count) : null);
    }));
  }

  function Segmented(p) {
    var items = p.items || [];
    var refs = useRef([]);
    var current = items.findIndex(function (it) { return it.id === p.value; });
    function pick(i) { var it = items[i]; if (!it) return; if (p.onChange && it.id !== p.value) p.onChange(it.id); var el = refs.current[i]; if (el) try { el.focus(); } catch (_) {} }
    function onKey(e, i) {
      var d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (e.key === 'Home') { e.preventDefault(); pick(0); return; }
      if (e.key === 'End') { e.preventDefault(); pick(items.length - 1); return; }
      if (!d || !items.length) return;
      e.preventDefault();
      pick((i + d + items.length) % items.length);
    }
    return h('div', { className: cx('sx-seg', p.className), role: 'radiogroup', 'aria-label': p.label }, items.map(function (it, i) {
      var sel = it.id === p.value;
      return h('button', { key: it.id, ref: function (el) { refs.current[i] = el; }, type: 'button', role: 'radio', 'aria-checked': sel, tabIndex: sel || (current < 0 && i === 0) ? 0 : -1, className: cx('sx-seg__item', sel && 'is-active'), onClick: function () { pick(i); }, onKeyDown: function (e) { onKey(e, i); } },
        it.label, it.dot ? h('span', { className: 'sx-seg__dot', 'aria-hidden': true }) : null,
        it.dot ? h('span', { className: 'sx-vh' }, ' (' + (it.dotLabel || 'needs attention') + ')') : null);
    }));
  }

  function NavItem(p) {
    return h(p.href ? 'a' : 'button', { href: p.href, type: p.href ? undefined : 'button', className: cx('sx-nav', p.active && 'is-active'), 'aria-current': p.active ? 'page' : undefined, onClick: p.onClick },
      p.icon ? h(Icon, { name: p.icon, size: 18 }) : null, h('span', { className: 'sx-nav__label' }, p.label),
      p.count != null ? h('span', { className: 'sx-nav__count' }, p.count) : null);
  }

  function Badge(p) {
    return h('span', { className: cx('sx-badge', 'sx-badge--' + (p.tone || 'neutral')) }, p.dot ? h('span', { className: 'sx-dot' }) : null, p.icon ? h(Icon, { name: p.icon, size: 12, strokeWidth: 2.25 }) : null, p.children);
  }

  var STATUS = { online: ['matcha', 'Online'], working: ['shiba', 'Working'], waiting: ['warning', 'Needs you'], idle: ['neutral', 'Sleeping'], error: ['danger', 'Error'] };
  function AgentStatus(p) {
    var st = STATUS[p.status] || STATUS.online;
    return h('span', { className: cx('sx-status', 'sx-status--' + (p.status || 'online')) }, p.status === 'working' ? h(Wave, { size: 12, decorative: true, className: 'sx-status__wave' }) : h('span', { className: 'sx-status__dot' }), p.label || st[1]);
  }

  function Avatar(p) {
    var size = p.size || 32, kind = p.kind || 'agent';
    var inner = kind === 'agent' ? h(Mascot, { mood: p.mood || 'default', size: size, crop: true, label: p.name || 'Shibaox' })
      : h('span', { className: 'sx-avatar__initials', style: { fontSize: Math.round(size * 0.4) } }, (p.name || '?').split(' ').map(function (w) { return w[0]; }).slice(0, 2).join('').toUpperCase());
    return h('span', { className: cx('sx-avatar', 'sx-avatar--' + kind), style: { width: size, height: size } }, inner,
      p.status ? h('span', { className: 'sx-avatar__status sx-status--' + p.status, 'aria-label': (STATUS[p.status] || [])[1] }) : null);
  }

  function Message(p) {
    var from = p.from || 'agent';
    return h('div', { className: cx('sx-msg', 'sx-msg--' + from) },
      from === 'agent' ? h(Avatar, { kind: 'agent', mood: p.mood, size: 32 }) : null,
      h('div', { className: 'sx-msg__col' },
        (p.name || p.time || p.model) ? h('div', { className: 'sx-msg__meta' }, p.name ? h('span', { className: 'sx-msg__name' }, p.name) : null, p.time ? h('span', null, p.time) : null, p.model ? h('span', { className: 'sx-msg__model', title: 'The model that wrote this' }, p.model) : null) : null,
        h('div', { className: 'sx-msg__body' }, p.children)));
  }

  var TOOL = { running: ['info', 'Running'], done: ['matcha', 'Done'], error: ['danger', 'Failed'], approval: ['warning', 'Needs approval'] };
  function ToolCall(p) {
    var s = useState(!!p.defaultOpen), open = s[0], status = p.status || 'done';
    var st = TOOL[status];
    return h('div', { className: cx('sx-tool', 'sx-tool--' + status, open && 'is-open') },
      h('button', { type: 'button', className: 'sx-tool__head', 'aria-expanded': open, onClick: function () { s[1](!open); } },
        h('span', { className: 'sx-tool__icon' }, status === 'running' ? h(Spinner) : h(Icon, { name: p.icon || 'terminal', size: 16 })),
        h('span', { className: 'sx-tool__name' }, p.tool),
        p.summary ? h('span', { className: 'sx-tool__summary' }, p.summary) : null,
        h('span', { className: 'sx-tool__spacer' }),
        p.duration ? h('span', { className: 'sx-tool__dur' }, p.duration) : null,
        h(Badge, { tone: st[0], icon: status === 'done' ? 'check' : status === 'error' ? 'x' : status === 'approval' ? 'triangle-alert' : null }, st[1]),
        h(Icon, { name: 'chevron-down', size: 16, className: 'sx-tool__chev' })),
      open ? h('div', { className: 'sx-tool__body' },
        p.args ? h('pre', { className: 'sx-tool__args' }, typeof p.args === 'string' ? p.args : JSON.stringify(p.args, null, 2)) : null,
        p.children ? h('div', { className: 'sx-tool__out' }, p.children) : null) : null,
      status === 'approval' && p.onApprove ? h('div', { className: 'sx-tool__actions' }, h(Button, { size: 'sm', variant: 'primary', icon: 'check', onClick: p.onApprove }, 'Approve'), h(Button, { size: 'sm', variant: 'quiet', onClick: p.onDeny }, 'Deny')) : null);
  }

  function ThinkingIndicator(p) {
    return h('div', { className: 'sx-thinking', role: 'status' }, h(Avatar, { kind: 'agent', mood: 'thinking', size: 28 }),
      h(TextShimmer, { className: 'sx-thinking__label', duration: 1.1 }, p.label || 'Sniffing around'));
  }

  function CodeBlock(p) {
    var s = useState(false), clip = useState(true);
    var raw = p.code !== undefined ? p.code : (typeof p.children === 'string' ? p.children : '');
    function copy() { var c = navigator.clipboard; if (!c || !c.writeText) return; c.writeText(String(raw)).then(function () { s[1](true); setTimeout(function () { s[1](false); }, 1400); }, function () {}); }
    var lines = raw ? raw.split('\n').length : 0;
    var clippable = p.maxHeight && (lines > 12 || raw.length > 1500);
    return h('div', { className: cx('sx-code', p.wrap && 'sx-code--wrap', clippable && clip[0] && 'is-clipped', p.className), style: p.maxHeight ? { '--code-max': typeof p.maxHeight === 'number' ? p.maxHeight + 'px' : p.maxHeight } : undefined },
      h('div', { className: 'sx-code__bar' },
        h('div', null, p.filename ? h('span', { className: 'sx-code__file' }, p.filename) : null, h('span', null, p.language || 'text')),
        h('div', null,
          p.actions || null,
          clippable ? h('button', { type: 'button', className: 'sx-code__copy', 'aria-expanded': !clip[0], onClick: function () { clip[1](!clip[0]); } }, clip[0] ? 'Show all (' + lines + ' lines)' : 'Show less') : null,
          h('button', { type: 'button', className: 'sx-code__copy', onClick: copy }, h(Icon, { name: s[0] ? 'check' : 'copy', size: 14 }), s[0] ? 'Copied' : 'Copy'))),
      h('pre', { className: 'sx-code__pre' }, h('code', null, p.children)));
  }

  var FILE_ICON = { png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', csv: 'table', tsv: 'table', md: 'file-text', txt: 'file-text', json: 'code', js: 'code', ts: 'code', tsx: 'code', jsx: 'code', py: 'code', go: 'code', php: 'code', rb: 'code', rs: 'code', css: 'code', html: 'code', yaml: 'code', yml: 'code', sh: 'code', sql: 'code' };
  function fileIcon(path) { var ext = (path.split('.').pop() || '').toLowerCase(); return FILE_ICON[ext] || 'file-text'; }
  function FileChip(p) {
    var name = p.name || (p.path || '').split('/').pop();
    var dir = p.path && p.path.indexOf('/') >= 0 ? p.path.slice(0, p.path.lastIndexOf('/')) : '';
    var tone = { added: 'matcha', modified: 'info', deleted: 'danger', renamed: 'neutral' }[p.status];
    return h(p.onClick ? 'button' : 'span', Object.assign({ className: cx('sx-filechip', p.onClick && 'is-interactive', p.className), title: p.path }, p.onClick ? { type: 'button', onClick: p.onClick } : {}),
      p.preview ? h('span', { className: 'sx-filechip__icon sx-filechip__icon--preview' }, p.previewKind === 'video' ? h('video', { className: 'sx-filechip__thumb', src: p.preview, muted: true, playsInline: true, preload: 'metadata' }) : h('img', { className: 'sx-filechip__thumb', src: p.preview, alt: '' })) : h('span', { className: 'sx-filechip__icon' }, h(Icon, { name: p.icon || fileIcon(p.path || name || ''), size: 16 })),
      h('span', { className: 'sx-filechip__text' }, h('span', { className: 'sx-filechip__name' }, name), (dir || p.meta) ? h('span', { className: 'sx-filechip__meta' }, [dir, p.meta].filter(Boolean).join(' · ')) : null),
      p.status ? h(Badge, { tone: tone }, p.status) : null);
  }

  function Sheet(p) {
    var ref = useRef(null), onClose = useRef(p.onClose);
    onClose.current = p.onClose;
    useEffect(function () {
      if (!p.open) return;
      function onKey(e) { if (e.key === 'Escape' && !e.defaultPrevented && onClose.current) { e.preventDefault(); onClose.current(); } }
      document.addEventListener('keydown', onKey);
      var root = ref.current;
      if (root) { var first = root.querySelector('.sx-sheet__body [tabindex], .sx-sheet__body button, .sx-sheet__close'); try { (first || root).focus({ preventScroll: true }); } catch (_) {} }
      return function () { document.removeEventListener('keydown', onKey); };
    }, [p.open]);
    if (!p.open) return null;
    return h('aside', { className: cx('sx-sheet', p.className), role: 'dialog', 'aria-modal': 'false', 'aria-label': p.label || (typeof p.title === 'string' ? p.title : undefined), ref: ref, tabIndex: -1, style: p.width ? { width: p.width } : undefined },
      h('div', { className: 'sx-sheet__head' },
        p.icon ? h('span', { className: 'sx-sheet__icon' }, h(Icon, { name: p.icon, size: 18 })) : null,
        h('div', { className: 'sx-sheet__titles' }, h('div', { className: 'sx-sheet__title' }, p.title), p.subtitle ? h('div', { className: 'sx-sheet__subtitle' }, p.subtitle) : null),
        p.actions ? h('div', { className: 'sx-sheet__actions' }, p.actions) : null,
        h(IconButton, { icon: 'x', label: 'Close', size: 'sm', className: 'sx-sheet__close', onClick: p.onClose })),
      h('div', { className: 'sx-sheet__body sx-scroll' }, p.children),
      p.footer ? h('div', { className: 'sx-sheet__foot' }, p.footer) : null);
  }

  function Textarea(p) {
    var rest = Object.assign({}, p);
    ['label', 'hint', 'error', 'className', 'rows'].forEach((k) => { delete rest[k]; });
    var ref = React.useRef(null); if (ref.current === null) ref.current = 'sxt' + (++uid);
    var id = p.id || ref.current;
    // the label names the field alone; the hint describes it (as Input does)
    return h('div', { className: cx('sx-field', 'sx-field--area', p.error && 'is-error', p.className) },
      p.label ? h('label', { className: 'sx-field__label', htmlFor: id }, p.label) : null,
      h('textarea', Object.assign({ className: 'sx-field__area', rows: p.rows || 4, id: id, 'aria-invalid': p.error ? true : undefined, 'aria-describedby': (p.error || p.hint) ? id + '-d' : undefined }, rest)),
      (p.error || p.hint) ? h('p', { id: id + '-d', className: 'sx-field__hint' }, p.error || p.hint) : null);
  }

  function Select(p) {
    var s = useState(false), open = s[0];
    var current = (p.options || []).find(function (o) { return o.id === p.value; });
    var id = p.id || (p.label ? 'sel-' + p.label.toLowerCase().replace(/[^a-z0-9]+/g, '-') : undefined);
    return h('div', { className: cx('sx-field', p.className) },
      p.label ? h('span', { className: 'sx-field__label', id: id ? id + '-label' : undefined }, p.label) : null,
      h(Menu, { open: open, onClose: function () { s[1](false); }, align: 'start', width: p.width || 280,
        items: (p.options || []).map(function (o) { return { id: o.id, label: o.label, hint: o.hint, icon: o.icon, disabled: o.disabled, checked: o.id === p.value }; }),
        onSelect: function (v) { if (p.onChange) p.onChange(v); },
        anchor: h('button', { type: 'button', id: id, className: cx('sx-select', !current && 'is-empty'), 'aria-label': p.label, 'aria-haspopup': 'menu', 'aria-expanded': open, disabled: p.disabled, onClick: function () { s[1](!open); } },
          h('span', { className: 'sx-select__value' }, current ? current.label : (p.placeholder || 'Choose')),
          h(Icon, { name: 'chevron-down', size: 16 })) }),
      p.hint ? h('span', { className: 'sx-field__hint' }, p.hint) : null);
  }

  function Dialog(p) {
    var ref = useRef(null), onClose = useRef(p.onClose);
    onClose.current = p.onClose;
    useEffect(function () {
      if (!p.open) return;
      function onKey(e) { if (e.key === 'Escape' && !e.defaultPrevented && onClose.current) { e.preventDefault(); onClose.current(); } }
      document.addEventListener('keydown', onKey);
      var root = ref.current;
      if (root) { var first = root.querySelector('input, textarea, select, button.sx-select, .sx-dialog__foot button, button'); try { (first || root).focus({ preventScroll: true }); } catch (_) {} }
      return function () { document.removeEventListener('keydown', onKey); };
    }, [p.open]);
    if (!p.open) return null;
    return h('div', { className: 'sx-scrim', onMouseDown: function (e) { if (e.target === e.currentTarget && onClose.current) onClose.current(); } },
      h('div', { className: cx('sx-dialog', p.className), role: 'dialog', 'aria-modal': 'true', 'aria-label': p.label || (typeof p.title === 'string' ? p.title : undefined), ref: ref, tabIndex: -1, style: p.width ? { width: p.width } : undefined },
        h('div', { className: 'sx-dialog__head' },
          p.icon ? h('span', { className: 'sx-dialog__icon' }, h(Icon, { name: p.icon, size: 18 })) : null,
          h('div', { className: 'sx-dialog__titles' }, h('div', { className: 'sx-dialog__title' }, p.title), p.description ? h('div', { className: 'sx-dialog__desc' }, p.description) : null),
          h(IconButton, { icon: 'x', label: 'Close', size: 'sm', onClick: p.onClose })),
        h('div', { className: 'sx-dialog__body sx-scroll' }, p.children),
        p.footer ? h('div', { className: 'sx-dialog__foot' }, p.footer) : null));
  }

  function Table(p) {
    var align = p.align || [];
    var cls = function (i) { var a = align[i]; return a === 'right' ? 'is-num' : a === 'center' ? 'is-center' : undefined; };
    return h('div', { className: cx('sx-table-wrap', p.className) },
      h('table', { className: cx('sx-table', p.dense && 'sx-table--dense') },
        p.caption ? h('caption', null, p.caption) : null,
        p.columns ? h('thead', null, h('tr', null, p.columns.map(function (c, i) { return h('th', { key: i, scope: 'col', className: cls(i) }, c); }))) : null,
        h('tbody', null, (p.rows || []).map(function (r, i) { return h('tr', { key: i }, r.map(function (c, j) { return h('td', { key: j, className: cls(j) }, c); })); }))));
  }

  function Kbd(p) { return h('kbd', { className: 'sx-kbd' }, p.children); }

  function Card(p) {
    return h('div', { className: cx('sx-card', p.interactive && 'is-interactive', p.className) },
      (p.icon || p.title || p.aside) ? h('div', { className: 'sx-card__head' }, p.icon ? h('span', { className: 'sx-card__icon' }, h(Icon, { name: p.icon, size: 18 })) : null,
        h('div', { className: 'sx-card__text' }, p.title ? h('div', { className: 'sx-card__title' }, p.title) : null, p.description ? h('div', { className: 'sx-card__desc' }, p.description) : null, p.meta ? h('div', { className: 'sx-card__meta' }, p.meta) : null),
        p.action ? h('div', { className: 'sx-card__action' }, p.action) : null,
        p.aside ? h('div', { className: 'sx-card__aside' }, p.aside) : null) : null,
      p.children ? h('div', { className: 'sx-card__body' }, p.children) : null,
      p.footer ? h('div', { className: 'sx-card__foot' }, p.footer) : null);
  }

  function Toast(p) {
    var tone = p.tone || 'neutral';
    var icon = { matcha: 'check', danger: 'x', warning: 'triangle-alert', info: 'info', neutral: 'info', shiba: 'zap' }[tone];
    return h('div', { className: cx('sx-toast', 'sx-toast--' + tone), role: tone === 'danger' ? 'alert' : 'status' },
      h('span', { className: 'sx-toast__icon' }, h(Icon, { name: icon, size: 16, strokeWidth: 2.25 })),
      h('div', { className: 'sx-toast__text' }, p.title ? h('div', { className: 'sx-toast__title' }, p.title) : null, p.children ? h('div', { className: 'sx-toast__desc' }, p.children) : null),
      p.action || null, p.onClose ? h(IconButton, { icon: 'x', label: 'Dismiss', size: 'sm', onClick: p.onClose }) : null);
  }

  var hasFiles = function (e) { var t = e.dataTransfer; if (!t) return false; if (t.files && t.files.length) return true; var types = t.types; if (!types) return false; for (var i = 0; i < types.length; i++) if (types[i] === 'Files') return true; return false; };
  var SIZE = function (n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; };
  function Composer(p) {
    var inner = useState(p.defaultValue || ''), controlled = p.value !== undefined, v = controlled ? p.value : inner[0];
    var over = useState(false), fileInput = useRef(null);
    function setText(t) { if (!controlled) inner[1](t); if (p.onChange) p.onChange(t); }
    var canSend = !!(v.trim() || (p.attachments && p.attachments.length));
    // controlled text is cleared by the consumer once the message was taken; our own is cleared here
    function send() { if (!canSend || p.busy) return; if (p.onSend) p.onSend(v); if (!controlled) inner[1](''); }
    function files(list) { var out = []; for (var i = 0; i < list.length; i++) out.push(list[i]); if (out.length && p.onAttach) p.onAttach(out); }
    var attachments = p.attachments || [];
    return h('div', { className: cx('sx-composer', p.busy && 'is-busy', (over[0] || p.dropping) && 'is-dropping'),
        onDragOver: p.onAttach ? function (e) { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); over[1](true); } : undefined,
        onDragLeave: p.onAttach ? function (e) { if (e.currentTarget && e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return; over[1](false); } : undefined,
        onDrop: p.onAttach ? function (e) { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); over[1](false); files(e.dataTransfer.files); } : undefined },
      attachments.length ? h('div', { className: 'sx-composer__files', role: 'list', 'aria-label': 'Attachments' },
        attachments.map(function (a, i) {
          return h('span', { key: a.name + i, className: 'sx-composer__file', role: 'listitem' },
            a.preview ? (a.previewKind === 'video' ? h('video', { className: 'sx-composer__thumb', src: a.preview, muted: true, playsInline: true, preload: 'metadata' }) : h('img', { className: 'sx-composer__thumb', src: a.preview, alt: '' })) : h(Icon, { name: FILE_ICON[(a.name.split('.').pop() || '').toLowerCase()] || 'file-text', size: 14 }),
            h('span', { className: 'sx-composer__filename' }, a.name),
            a.size !== undefined ? h('span', { className: 'sx-composer__filesize' }, SIZE(a.size)) : null,
            p.onRemoveAttachment ? h('button', { type: 'button', className: 'sx-composer__remove', 'aria-label': 'Remove ' + a.name, onClick: function () { p.onRemoveAttachment(i); } }, h(Icon, { name: 'x', size: 12 })) : null);
        })) : null,
      h('textarea', { className: 'sx-composer__input', rows: 2, placeholder: p.placeholder || 'Ask Shibaox to do something…', value: v, 'aria-label': 'Message', onChange: function (e) { setText(e.target.value); }, onKeyDown: function (e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); } }),
      h('div', { className: 'sx-composer__bar' },
        p.onAttach ? h('input', { ref: fileInput, type: 'file', multiple: true, hidden: true, 'aria-hidden': true, tabIndex: -1, onChange: function (e) { files(e.target.files || []); e.target.value = ''; } }) : null,
        h(IconButton, { icon: 'plus', label: 'Attach', size: 'sm', onClick: p.onAttach ? function () { if (fileInput.current) fileInput.current.click(); } : undefined, disabled: !p.onAttach }),
        p.onActionsClick || p.actionsMenu
          ? h(Popover, { open: !!p.actionsMenu, onClose: p.onActionsMenuClose || p.onActionsClick, placement: 'up', role: 'presentation',
              anchor: h(IconButton, { icon: 'zap', label: 'Actions', size: 'sm', onClick: p.onActionsClick, 'aria-haspopup': 'menu', 'aria-expanded': !!p.actionsMenu }) },
              p.actionsMenu || null)
          : h(IconButton, { icon: 'zap', label: 'Actions', size: 'sm', disabled: true }),
        p.model && (p.onModelClick || p.modelMenu)
          ? h(Popover, { open: !!p.modelMenu, onClose: p.onModelMenuClose || p.onModelClick, placement: 'up', role: 'presentation',
              anchor: h('button', { type: 'button', className: 'sx-composer__model sx-composer__model--btn', 'aria-label': 'Change model', 'aria-haspopup': 'menu', 'aria-expanded': !!p.modelMenu, onClick: p.onModelClick }, p.model, h(Icon, { name: 'chevron-down', size: 12 })) },
              p.modelMenu || null)
          : p.model ? h('span', { className: 'sx-composer__model' }, p.model) : null,
        h('span', { className: 'sx-tool__spacer' }),
        p.voice === false ? null : h(IconButton, { icon: 'mic', label: p.listening ? 'Stop listening' : 'Voice', size: 'sm', variant: p.listening ? 'primary' : undefined, onClick: p.onVoice, disabled: !p.onVoice, 'aria-pressed': !!p.listening }),
        // while busy, Stop is its own labelled button and Send stays where it was, disabled: a second
        // click on the orange button never cancels the turn
        p.busy ? h(Button, { variant: 'secondary', size: 'sm', icon: 'square', className: 'sx-composer__stop', onClick: p.onStop }, 'Stop') : null,
        h(IconButton, { icon: 'arrow-up', label: 'Send', variant: 'primary', size: 'sm', onClick: send, disabled: !canSend || !!p.busy })));
  }

  function Popover(p) {
    var ref = useRef(null), onClose = useRef(p.onClose);
    onClose.current = p.onClose;
    useEffect(function () {
      if (!p.open) return;
      var root = ref.current;
      function close() { if (onClose.current) onClose.current(); }
      // the top layer takes the Escape: a dialog underneath ignores an event a popover handled
      function onKey(e) { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close(); } }
      function onDown(e) { if (root && !root.contains(e.target)) close(); }
      document.addEventListener('keydown', onKey);
      document.addEventListener('mousedown', onDown);
      var panel = root && root.querySelector('.sx-popover__panel');
      if (panel && !panel.contains(document.activeElement)) {
        var first = panel.querySelector('.sx-menu__item.is-active, input, textarea, select, [role="menu"], button');
        try { (first || panel).focus({ preventScroll: true }); } catch (_) {}
      }
      return function () {
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('mousedown', onDown);
        // the keyboard goes back to the trigger unless the user already moved it elsewhere
        var active = document.activeElement;
        if (root && (!active || active === document.body || (panel && panel.contains(active)))) {
          var anchor = root.querySelector('button, [tabindex]');
          if (anchor && anchor !== panel) try { anchor.focus({ preventScroll: true }); } catch (_) {}
        }
      };
    }, [p.open]);
    return h('span', { className: cx('sx-popover', p.align === 'end' && 'sx-popover--end', p.placement === 'up' && 'sx-popover--up', p.className), ref: ref },
      p.anchor || null,
      p.open ? h('div', { className: 'sx-popover__panel', role: p.role || 'dialog', 'aria-label': p.label, tabIndex: -1, style: p.width ? { width: p.width } : undefined }, p.children) : null);
  }

  function MenuList(p) {
    var q = useState(''), query = q[0];
    var all = p.items || [];
    // a search field above long lists: items whose label or hint carry the words
    var items = p.search && query.trim() ? all.filter(function (it) { if (it.id === '-') return false; var hay = ((it.label || '') + ' ' + (it.hint || '')).toLowerCase(); return query.trim().toLowerCase().split(/\s+/).every(function (w) { return hay.indexOf(w) >= 0; }); }) : all;
    var radio = items.some(function (it) { return it.checked !== undefined; });
    var start = items.findIndex(function (it) { return it.checked; });
    var s = useState(start >= 0 ? start : items.findIndex(function (it) { return !it.disabled && it.id !== '-'; })), active = s[0];
    var touched = useRef(false);
    // items often arrive after the menu opened (a list fetched on demand): follow the checked one until the user moves
    useEffect(function () { if (touched.current) return; if (start >= 0) s[1](start); else s[1](items.findIndex(function (it) { return !it.disabled && it.id !== '-'; })); }, [start, items.length]);
    function select(it) { if (it.disabled) return; if (p.onSelect) p.onSelect(it.id); if (p.onClose) p.onClose(); }
    function onKey(e) {
      var enabled = []; items.forEach(function (it, i) { if (!it.disabled && it.id !== '-') enabled.push(i); });
      if (!enabled.length) return;
      touched.current = true;
      if ((e.key === 'Enter' || e.key === ' ') && (active < 0 || !items[active] || items[active].disabled) && p.search) { e.preventDefault(); select(items[enabled[0]]); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        var i = enabled.indexOf(active), d = e.key === 'ArrowDown' ? 1 : -1;
        s[1](enabled[i < 0 ? (d > 0 ? 0 : enabled.length - 1) : (i + d + enabled.length) % enabled.length]);
      } else if ((e.key === 'Enter' || e.key === ' ') && active >= 0) { e.preventDefault(); select(items[active]); }
    }
    return h('div', { className: cx('sx-menu', p.className), role: 'menu', tabIndex: -1, onKeyDown: onKey, 'aria-label': p.label },
      p.title ? h('div', { className: 'sx-menu__title' }, p.title) : null,
      p.search ? h('div', { className: 'sx-menu__search' }, h(Icon, { name: 'search', size: 14 }), h('input', { type: 'search', className: 'sx-menu__input', placeholder: typeof p.search === 'string' ? p.search : 'Search…', 'aria-label': typeof p.search === 'string' ? p.search : 'Search', value: query, autoFocus: true, onChange: function (e) { q[1](e.target.value); touched.current = true; s[1](0); }, onKeyDown: function (e) { if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') { onKey(e); } else if (e.key !== 'Escape') { e.stopPropagation(); } } })) : null,
      p.search && items.length === 0 ? h('div', { className: 'sx-menu__empty' }, 'Nothing matches') : null,
      items.map(function (it, i) {
        if (it.id === '-') return h('div', { key: 'sep' + i, className: 'sx-menu__sep', role: 'separator' });
        return h('button', { key: it.id, type: 'button', role: radio ? 'menuitemradio' : 'menuitem', 'aria-checked': radio ? !!it.checked : undefined, className: cx('sx-menu__item', i === active && 'is-active', it.tone === 'danger' && 'sx-menu__item--danger'), disabled: it.disabled, onMouseEnter: function () { touched.current = true; s[1](i); }, onClick: function () { select(it); } },
          it.icon ? h(Icon, { name: it.icon, size: 16 }) : null,
          h('span', { className: 'sx-menu__text' }, h('span', { className: 'sx-menu__label' }, it.label), it.hint ? h('span', { className: 'sx-menu__hint' }, it.hint) : null),
          it.checked ? h(Icon, { name: 'check', size: 16, className: 'sx-menu__check' }) : null);
      }));
  }

  function Menu(p) {
    return h(Popover, { open: p.open, onClose: p.onClose, anchor: p.anchor, align: p.align, placement: p.placement, role: 'presentation', width: p.width, className: p.className },
      h(MenuList, { items: p.items, onSelect: p.onSelect, onClose: p.onClose, title: p.title }));
  }

  var api = { Icon: Icon, Mascot: Mascot, Button: Button, IconButton: IconButton, Input: Input, Switch: Switch, Composer: Composer, Tabs: Tabs, Segmented: Segmented, NavItem: NavItem, Badge: Badge, AgentStatus: AgentStatus, Toast: Toast, Avatar: Avatar, Message: Message, ToolCall: ToolCall, ThinkingIndicator: ThinkingIndicator, CodeBlock: CodeBlock, Card: Card, Kbd: Kbd, Spinner: Spinner, Wave: Wave, TextShimmer: TextShimmer, Popover: Popover, MenuList: MenuList, Menu: Menu, Table: Table, Sheet: Sheet, FileChip: FileChip, Textarea: Textarea, Select: Select, Dialog: Dialog };
  window.Shibaox = Object.assign(window.Shibaox || {}, api);
})();
