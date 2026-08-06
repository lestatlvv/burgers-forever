# Keyboard navigation reference

Burgers Forever kiosk UI is navigated with five pad buttons (plus an optional volume key).

| Physical key | Logical command |
| --- | --- |
| ↑ Arrow Up | `UP` |
| ↓ Arrow Down | `DOWN` |
| ← Arrow Left | `LEFT` |
| → Arrow Right | `RIGHT` |
| Enter / Numpad Enter | `SELECT` |
| `V` (dev fallback) | `VOLUME` (cycles speech volume; not a navigation key) |

Implementation: `js/keyboard-nav.js`  
Product/cart demo data: `js/demo-products.js`

---

## App flow

```text
index.html  ──(any of 5 keys)──►  products.html  ──(Finish purchase)──►  thank-you.html
     ▲                                    │                                   │
     │                                    │ open cart overlay                 │
     │                                    ▼                                   │
     └──────────────(timeout / Make another purchase)─────────────────────────┘
```

---

## 1. Start page — `index.html`

**Focusable control:** `Press here to order` (`.startorderbtn`)

| Key | Action |
| --- | --- |
| **Up** | Go to menu (`products.html`) |
| **Down** | Go to menu (`products.html`) |
| **Left** | Go to menu (`products.html`) |
| **Right** | Go to menu (`products.html`) |
| **Enter** | Go to menu (`products.html`) |

Any of the five navigation keys starts the order and opens the products menu.

---

## 2. Products / menu page — `products.html`

### 2.1 Product grid (cart closed)

**Focusable controls:**

- Product cards (burgers / beer / wine) — whole card is the target
- Cart button (open basket)

**Default focus:** first product card (Classic).

| Key | Action |
| --- | --- |
| **Up / Down / Left / Right** | Move focus spatially across the grid (prefer same column for vertical moves) |
| **Enter** | Add the focused product to the basket |

**Grid layout (demo catalog):**

```text
Classic    Cheese    BBQ
Lager      IPA       Stout
Red        White     Rosé
                     [Cart]
```

Notes:

- Vertical moves stay on product cards in the same column when possible (e.g. **Stout + Up → BBQ**, not the floating cart).
- **Down** from the bottom row can reach the **Cart** button.
- **Up** from **Cart** returns to the nearest product above.

### 2.2 Cart overlay (basket open)

**Focusable controls (linear list, top → bottom):**

1. **Close** (exit cart)
2. Cart product rows (one per line item)
3. **Finish purchase**

**Default focus when cart opens:** **Finish purchase**

#### Vertical navigation (Up / Down)

Walks the list linearly and **wraps**:

```text
Close  ↔  product row(s)  ↔  Finish purchase
```

| From | Key | Goes to |
| --- | --- | --- |
| Finish purchase | **Up** | Last product row (or Close if empty) |
| Product row | **Up** | Previous row, then Close |
| Close | **Up** | **Finish purchase** (wrap) |
| Close | **Down** | First product row (or Finish) |
| Product row | **Down** | Next row, then Finish purchase |
| Finish purchase | **Down** | **Close** (wrap) |

#### Horizontal navigation on a product row (Left / Right)

When a **cart product row** is focused:

| Key | Action |
| --- | --- |
| **Left** | Decrease quantity (−). Removes the line at quantity 0 |
| **Right** | Increase quantity (+) |
| **Enter** | No action on the row (qty is changed with Left/Right) |

Focus stays on the same product row after a quantity change (unless the item is removed).

#### Activate (Enter) on cart chrome

| Focused control | Enter |
| --- | --- |
| **Finish purchase** | Complete order (print hook + go to `thank-you.html`) |
| **Close** | Close the cart overlay and return to the product grid |
| Product row | No-op (use Left/Right for qty) |

---

## 3. Thank-you page — `thank-you.html`

**Focusable control:** `Make another purchase` (`.startorderbtn`)

This page has no product grid. The start-screen rule also applies here (start CTA present, no `.productsmain`):

| Key | Action |
| --- | --- |
| **Up / Down / Left / Right / Enter** | Activate **Make another purchase** → `index.html` |

The page also auto-returns to `index.html` after a short idle timeout.

---

## 4. Screen-size chooser — `old-home.html` (optional)

**Focusable controls:**

- `1080x1920` (`.screen-01`) → `index.html`
- `1024x768` (`.screen-01`) → `home-02.html`

| Key | Action |
| --- | --- |
| **Left / Right / Up / Down** | Move focus between the two screen-size buttons |
| **Enter** | Open the focused size option |

---

## 5. Global behaviours

- Focused controls show a pink/yellow **keyboard focus ring** (`.kb-focused`).
- Any navigation key resets kiosk idle timers (`kb-activity`) where those are wired.
- **`V` / Volume** cycles speech volume; it does not move focus or change page.
- Checkout / form text fields (if present on other pages) ignore arrow keys while typing.

---

## Quick cheat sheet

| Page | Up/Down/Left/Right | Enter |
| --- | --- | --- |
| **Start** (`index`) | Open menu | Open menu |
| **Products** (grid) | Move between products / cart | Add product to basket |
| **Cart** (overlay) | Up/Down: Close ↔ lines ↔ Finish (wrap). Left/Right on a line: − / + qty | Finish or Close |
| **Thank you** | Return to start | Return to start |
| **Screen chooser** | Move between sizes | Open selected size |
