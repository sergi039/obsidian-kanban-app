# Техническое задание: Локальная версия GitHub Projects (Канбан-доска)

**Цель:** Разработать веб-приложение, эмулирующее ключевую функциональность GitHub Projects с фокусом на канбан-доски. Приложение должно быть построено на современном стеке и следовать архитектуре, описанной ниже. Это ТЗ предназначено для использования LLM-ассистентом по программированию (Claude Code).

## 1. Обзор архитектуры

Приложение будет состоять из трех основных частей:

1.  **Frontend:** Одностраничное приложение (SPA), написанное на React/TypeScript с использованием TailwindCSS для стилизации. Отвечает за весь пользовательский интерфейс.
2.  **Backend:** RESTful API на Node.js с использованием Express.js или NestJS. Отвечает за бизнес-логику, взаимодействие с базой данных и аутентификацию.
3.  **Database:** Реляционная база данных PostgreSQL для хранения всех данных.

## 2. Модели данных (Схема БД)

Ниже представлены основные сущности и их поля в формате, близком к Prisma Schema.

```prisma
// 1. Пользователи
model User {
  id        String   @id @default(cuid())
  email     String   @unique
  name      String?
  avatarUrl String?
  projects  Project[]
  items     Item[]     @relation("Assignee")
}

// 2. Проекты
model Project {
  id          String   @id @default(cuid())
  name        String
  description String?
  ownerId     String
  owner       User     @relation(fields: [ownerId], references: [id])
  items       Item[]
  views       View[]
  fields      Field[]
}

// 3. Элементы (Карточки)
model Item {
  id          String    @id @default(cuid())
  title       String
  body        String?
  itemType    String    // "ISSUE", "PULL_REQUEST", "DRAFT_ISSUE"
  status      String?   // Связано с SingleSelect полем
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  projectId   String
  project     Project   @relation(fields: [projectId], references: [id])
  assigneeId  String?
  assignee    User?     @relation("Assignee", fields: [assigneeId], references: [id])
  fieldValues Json?     // { "fieldId": "value" }
}

// 4. Представления (Views)
model View {
  id        String   @id @default(cuid())
  name      String
  layout    String   // "TABLE", "BOARD", "ROADMAP"
  filter    String?  // Строка с правилами фильтрации
  sorting   Json?    // { "fieldId": "ASC" | "DESC" }
  grouping  String?  // fieldId для группировки
  projectId String
  project   Project  @relation(fields: [projectId], references: [id])
}

// 5. Поля (Custom & Built-in)
model Field {
  id          String   @id @default(cuid())
  name        String
  type        String   // "TEXT", "NUMBER", "DATE", "SINGLE_SELECT", "ITERATION"
  options     Json?    // Для SINGLE_SELECT: [{ "id": "opt1", "name": "To Do", "color": "#FFF" }]
  projectId   String
  project     Project  @relation(fields: [projectId], references: [id])
}
```

## 3. Спецификация API (RESTful)

### Проекты (`/projects`)

*   `GET /projects`: Получить список всех проектов.
*   `POST /projects`: Создать новый проект.
    *   **Body:** `{ "name": "String", "description": "String?" }`
*   `GET /projects/{id}`: Получить детали одного проекта (включая его views, fields, items).
*   `PUT /projects/{id}`: Обновить проект.
*   `DELETE /projects/{id}`: Удалить проект.

### Элементы (`/projects/{projectId}/items`)

*   `GET /items?viewId={viewId}`: Получить отфильтрованный, отсортированный и сгруппированный список элементов для конкретного View.
*   `POST /items`: Создать новый элемент.
    *   **Body:** `{ "title": "String", "itemType": "DRAFT_ISSUE", "fieldValues": "Json?" }`
*   `PUT /items/{id}`: Обновить элемент (например, при перетаскивании).
    *   **Body:** `{ "status": "String?", "assigneeId": "String?", "fieldValues": "Json?" }`
*   `DELETE /items/{id}`: Удалить элемент.

### Представления (`/projects/{projectId}/views`)

*   `POST /views`: Создать новое представление.
    *   **Body:** `{ "name": "String", "layout": "BOARD", "filter": "String?", ... }`
*   `PUT /views/{id}`: Обновить настройки представления.

### Поля (`/projects/{projectId}/fields`)

*   `POST /fields`: Создать новое кастомное поле.
    *   **Body:** `{ "name": "String", "type": "SINGLE_SELECT", "options": "Json" }`
*   `PUT /fields/{id}`: Обновить поле (например, переименовать).

## 4. Компоненты Frontend (React)

*   **`KanbanBoard.tsx`**: Основной компонент доски.
    *   **State:** `items`, `columns`, `viewSettings`.
    *   **Props:** `projectId`, `viewId`.
    *   **Логика:** Загрузка данных, обработка drag-and-drop (с использованием `react-beautiful-dnd` или аналога), вызов API для обновления.

*   **`KanbanColumn.tsx`**: Компонент колонки.
    *   **Props:** `columnData`, `items`.
    *   **Логика:** Рендеринг карточек, отображение WIP-лимита.

*   **`KanbanCard.tsx`**: Компонент карточки.
    *   **Props:** `itemData`.
    *   **Логика:** Отображение полей элемента, открытие модального окна для редактирования.

*   **`FilterBar.tsx`**: Компонент для ввода и управления фильтрами.
    *   **State:** `filterQuery`.
    *   **Логика:** Обработка ввода, применение фильтра (вызов API для перезагрузки данных).

*   **`ViewSwitcher.tsx`**: Компонент для переключения между представлениями (views).

## 5. Детализация ключевой функциональности

### 5.1. Движок фильтрации (Backend)

Сервер должен парсить строку фильтра, полученную от клиента. Строка имеет следующий формат:

`[qualifier]:[value] [qualifier]:[value1],[value2] -[qualifier]:[value]`

**Задача:** Написать парсер, который преобразует эту строку в структуру, понятную для ORM (например, в объект `where` для Prisma).

**Пример грамматики (упрощенно):

```
query ::= expression*
expression ::= negation? qualifier separator value
negation ::= "-"
qualifier ::= "status" | "assignee" | "label" | ...
separator ::= ":"
value ::= singleValue | multiValue
singleValue ::= string | keyword // e.g., "Done", "@me"
multiValue ::= singleValue ("," singleValue)*
```

### 5.2. Drag-and-Drop (Frontend + Backend)

1.  **Frontend:** Библиотека (`react-beautiful-dnd`) отслеживает начало и конец перетаскивания.
2.  **Frontend:** В событии `onDragEnd` определяется, изменилась ли позиция карточки (колонка или индекс).
3.  **Frontend:** Если позиция изменилась, отправляется `PUT /items/{id}` запрос на бэкенд с новыми данными (например, `{"status": "newColumnId"}`).
4.  **Backend:** API-эндпоинт обновляет элемент в базе данных.
5.  **Frontend:** UI оптимистично обновляется, не дожидаясь ответа сервера, для плавности интерфейса.

### 5.3. Автоматизация (Backend)

Реализовать через систему событий и слушателей.

1.  **События:** Определить события, которые могут запускать автоматизацию (например, `item.created`, `item.updated`, `item.status.changed`).
2.  **Workflows:** Хранить в БД правила автоматизации в формате `{"trigger": "event_name", "condition": "filter_string", "action": "action_name", "payload": "..."}`.
3.  **Слушатели:** После каждого релевантного действия в системе (например, обновление item) генерировать событие.
4.  **Диспетчер:** Слушатель передает событие диспетчеру, который находит подходящие workflows, проверяет условия (`condition`) и выполняет действия (`action`).

**Пример действия:** `{"action": "set_field", "payload": {"fieldId": "status", "value": "Done"}}`

## 6. Технологический стек

*   **Frontend:** React, TypeScript, Vite, TailwindCSS, `react-beautiful-dnd`.
*   **Backend:** Node.js, NestJS (предпочтительно для структурированности) или Express.js, TypeScript.
*   **Database:** PostgreSQL.
*   **ORM:** Prisma.

Это техническое задание является основой для разработки. Ожидается, что Claude Code сможет генерировать код для отдельных компонентов, API-эндпоинтов и моделей данных на основе этой спецификации.
