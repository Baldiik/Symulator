# Ryzykownia na Netlify, z zapisem wyników

## Co jest w paczce

- `public/index.html`: gra (giełda, ruletka, automaty, moneta, procent składany)
- `netlify/functions/api.mjs`: funkcja, która zapisuje sesje w Netlify Blobs i sprawdza ich spójność
- `netlify.toml`, `package.json`: konfiguracja dla Netlify

## Ważne: nie przeciągaj folderu na Netlify Drop

Przy wgraniu przez przeciągnięcie folderu Netlify nie uruchamia funkcji. Gra by działała, ale nic by się nie zapisywało. Wgraj paczkę przez GitHuba (sposób A) albo przez Netlify CLI (sposób B).

## Sposób A: GitHub i Netlify (bez instalowania czegokolwiek)

1. Na github.com załóż nowe repozytorium (może być prywatne).
2. W repozytorium kliknij **Add file → Upload files** i przeciągnij **zawartość** folderu `ryzykownia-netlify`, czyli `public`, `netlify`, `netlify.toml`, `package.json`, `README.md`. Kliknij **Commit changes**.
   Pliki muszą leżeć w głównym katalogu repozytorium, a nie w podfolderze.
3. Na app.netlify.com kliknij **Add new project → Import an existing project → GitHub** i wybierz to repozytorium. Ustawienia zostaw bez zmian (wczyta je z `netlify.toml`) i kliknij **Deploy**.
4. Ustaw hasło prowadzącego: **Project configuration → Environment variables → Add a variable**
   - Key: `ADMIN_PASSWORD`
   - Value: Twoje hasło (długie, nie to samo co do poczty)
5. Wdróż stronę ponownie, żeby funkcja zobaczyła hasło: **Deploys → Trigger deploy → Deploy project**.

Każda późniejsza zmiana plików w repozytorium sama zaktualizuje stronę.

## Sposób B: Netlify CLI (wymaga Node.js 22)

```
cd ryzykownia-netlify
npm install
npx netlify-cli login
npx netlify-cli deploy --prod
```

Hasło ustawiasz tak samo jak w kroku 4 (w panelu Netlify albo `npx netlify-cli env:set ADMIN_PASSWORD "twoje-haslo"`), potem `npx netlify-cli deploy --prod` jeszcze raz.

## Jak to działa na zajęciach

- Student wpisuje imię (przy włączonym zapisie jest obowiązkowe) i gra. Gra sama wysyła pełną historię co ok. 15 s i zaraz po zakończeniu. W pasku na górze widać „Zapisano 12:03”.
- Ty otwierasz **Panel wyników**, wpisujesz hasło i widzisz wszystkie sesje z wybranego dnia. Odświeżają się co 30 s.
- **Cała historia → zakładka Weryfikacja** pokazuje, co sprawdził serwer:
  - saldo przeliczone z pełnej historii (wszystkie gry),
  - ruletka i moneta: każde losowanie odtworzone z kodu stołu, więc podmienionej liczby nie da się ukryć,
  - ruletka: każda wypłata przeliczona według zasad, stawki nie większe niż saldo,
  - kod wyniku zgodny z imieniem, kodem gry i saldem,
  - godziny wszystkich zapisów z zegara serwera (prawdziwa gra zostawia ciąg zapisów, wynik wpisany ręcznie zwykle nie),
  - flagi: zmiana wyniku po zakończeniu gry, zmiana imienia w trakcie, „to samo urządzenie co: …”.
- Zakończona sesja jest zamknięta. Późniejsze próby jej zmiany serwer tylko odnotowuje.
- **Pobierz JSON (archiwum)** zapisuje pełne dane wszystkich sesji z dnia na Twój komputer. **Kopiuj jako CSV** daje tabelę do arkusza.
- Pojedynczą sesję (np. próbną) usuniesz w zakładce Weryfikacja, przyciskiem „Usuń z serwera”.

## Uwagi

- Dane leżą w Netlify Blobs w regionie eu-central-1 (Frankfurt). Zbierane są: imię wpisane przez studenta, przebieg gry i losowy identyfikator przeglądarki. Bez adresów IP.
- Kontrole wykrywają ręczne zmiany wyniku i historii. Nie wykryją kogoś, kto przepisze cały program gry i będzie wysyłał spójne dane z własnego kodu.
- Darmowy plan Netlify ma miesięczne limity wywołań funkcji. Przy jednej klasie (ok. 30 osób, 45 minut) to kilka tysięcy zapisów na lekcję.
