# Mermaid Complete Syntax Reference

> Compiled from official Mermaid documentation. Version: 11.x

---

## Global Concepts

### Diagram Structure
Every diagram begins with a **diagram type keyword**, followed by the diagram body.

```
%%{init: { 'theme': 'dark' }}%%
diagramType [direction]
  ... body ...
```

### Comments
```
%% This is a comment (anything after %% to end of line)
```
Avoid `%%{ }%%` in comments — it conflicts with directives.

### Reserved Word
The word `end` breaks Flowchart and Sequence diagrams. Wrap it: `"end"`, `(end)`, `[end]`, or `{end}`.

---

### Frontmatter (YAML config block)
Must appear before the diagram keyword. The `---` must be the only character on the first line.

```yaml
---
title: My Diagram
displayMode: compact
config:
  theme: forest
  look: handDrawn
  layout: elk
  elk:
    mergeEdges: true
    nodePlacementStrategy: LINEAR_SEGMENTS   # SIMPLE | NETWORK_SIMPLEX | LINEAR_SEGMENTS | BRANDES_KOEPF
gantt:
  useWidth: 400
---
flowchart LR
  A --> B
```

### Directives (inline config)
```
%%{init: { 'theme': 'dark', 'flowchart': {'curve': 'linear'} }}%%
```

### Themes
Built-in themes: `default` | `forest` | `dark` | `neutral` | `base`

### Looks (flowchart & state only)
`look: handDrawn` | `look: classic`

### Layout Algorithms
`layout: dagre` (default) | `layout: elk` | `layout: tidy-tree` (mindmap)

### Accessibility
```
accTitle: This is the accessible title
accDescr: This is an accessible description
```

---

## 1. Flowchart

**Keyword:** `flowchart` (or `graph`)

### Direction
```
flowchart TB   % Top to Bottom (default)
flowchart TD   % Top-Down (same as TB)
flowchart BT   % Bottom to Top
flowchart LR   % Left to Right
flowchart RL   % Right to Left
```

### Node Shapes (Classic)
| Syntax | Shape |
|--------|-------|
| `id` | Rectangle (default) |
| `id[text]` | Rectangle |
| `id(text)` | Rounded edges |
| `id([text])` | Stadium / pill |
| `id[[text]]` | Subroutine (double vertical lines) |
| `id[(text)]` | Cylinder (database) |
| `id((text))` | Circle |
| `id>text]` | Asymmetric (flag/arrow right) |
| `id{text}` | Rhombus / diamond |
| `id{{text}}` | Hexagon |
| `id[/text/]` | Parallelogram |
| `id[\text\]` | Parallelogram alt |
| `id[/text\]` | Trapezoid |
| `id[\text/]` | Trapezoid alt |
| `id(((text)))` | Double circle |

### Node Shapes (v11.3.0+ Extended — `@{ shape: <name> }` syntax)
```
A@{ shape: rect, label: "Process" }
```

| Shape Name | Short Name | Aliases |
|-----------|------------|---------|
| Rectangle | `rect` | `proc`, `process`, `rectangle` |
| Rounded Rectangle | `rounded` | `event` |
| Stadium | `stadium` | `pill`, `terminal` |
| Subroutine / Framed Rectangle | `fr-rect` | `subproc`, `subprocess`, `subroutine`, `framed-rectangle` |
| Cylinder | `cyl` | `cylinder`, `database`, `db` |
| Circle | `circle` | `circ` |
| Small Circle | `sm-circ` | `small-circle`, `start` |
| Double Circle | `dbl-circ` | `double-circle` |
| Framed Circle | `fr-circ` | `framed-circle`, `stop` |
| Diamond | `diam` | `decision`, `diamond`, `question` |
| Hexagon | `hex` | `hexagon`, `prepare` |
| Lean Right | `lean-r` | `in-out`, `lean-right` |
| Lean Left | `lean-l` | `lean-left`, `out-in` |
| Trapezoid Base Bottom | `trap-b` | `priority`, `trapezoid`, `trapezoid-bottom` |
| Trapezoid Base Top | `trap-t` | `inv-trapezoid`, `manual`, `trapezoid-top` |
| Text Block | `text` | — |
| Notched Rectangle (Card) | `notch-rect` | `card`, `notched-rectangle` |
| Cloud | `cloud` | — |
| Hourglass (Collate) | `hourglass` | `collate` |
| Lightning Bolt (Com Link) | `bolt` | `com-link`, `lightning-bolt` |
| Curly Brace Left | `brace` | `brace-l`, `comment` |
| Curly Brace Right | `brace-r` | — |
| Curly Braces Both | `braces` | — |
| Delay / Half-Rounded | `delay` | `half-rounded-rectangle` |
| Horizontal Cylinder | `h-cyl` | `das`, `horizontal-cylinder` |
| Lined Cylinder (Disk) | `lin-cyl` | `disk`, `lined-cylinder` |
| Curved Trapezoid (Display) | `curv-trap` | `curved-trapezoid`, `display` |
| Divided Rectangle | `div-rect` | `div-proc`, `divided-process`, `divided-rectangle` |
| Document | `doc` | `document` |
| Filled Rectangle (Fork/Join) | `fork` | `join` |
| Window Pane (Internal Storage) | `win-pane` | `internal-storage`, `window-pane` |
| Filled Circle (Junction) | `f-circ` | `filled-circle`, `junction` |
| Lined Document | `lin-doc` | `lined-document` |
| Lined Rectangle | `lin-rect` | `lin-proc`, `lined-process`, `lined-rectangle`, `shaded-process` |
| Notched Pentagon | `notch-pent` | `loop-limit`, `notched-pentagon` |
| Flipped Triangle | `flip-tri` | `flipped-triangle`, `manual-file` |
| Sloped Rectangle | `sl-rect` | `manual-input`, `sloped-rectangle` |
| Stacked Document | `docs` | `documents`, `st-doc`, `stacked-document` |
| Stacked Rectangle | `st-rect` | `processes`, `procs`, `stacked-rectangle` |
| Odd | `odd` | — |
| Flag (Paper Tape) | `flag` | `paper-tape` |
| Bang | `bang` | — |
| Bow Tie Rectangle | `bow-rect` | `bow-tie-rectangle`, `stored-data` |
| Crossed Circle (Summary) | `cross-circ` | `crossed-circle`, `summary` |
| Tagged Document | `tag-doc` | `tagged-document` |
| Tagged Rectangle | `tag-rect` | `tag-proc`, `tagged-process`, `tagged-rectangle` |
| Triangle | `tri` | `extract`, `triangle` |

### Edge / Arrow Types
| Syntax | Description |
|--------|-------------|
| `A --> B` | Arrow |
| `A --- B` | Open link (no arrow) |
| `A --o B` | Circle edge |
| `A --x B` | Cross edge |
| `A <--> B` | Bidirectional arrow |
| `A -.-> B` | Dotted arrow |
| `A -.- B` | Dotted open link |
| `A ==> B` | Thick arrow |
| `A === B` | Thick open link |
| `A ~~~ B` | Invisible link |

**Arrow lengths** — add extra dashes/dots to increase length:
```
A ---> B      % longer arrow
A ----> B     % even longer
A -.-> B      % dotted
A -..-> B     % longer dotted
A ===> B      % longer thick
```

**Labels on edges:**
```
A -->|label text| B
A -- label text --> B
A -->|"text with spaces"| B
```

**Multi-directional:**
```
A & B --> C & D
```

### Subgraphs
```
subgraph title
  direction LR
  node1 --> node2
end
```

Subgraphs can have their own direction. External nodes can connect to subgraphs:
```
subgraph id1[Title]
  a --> b
end
subgraph id2[Title2]
  c --> d
end
id1 --> id2
```

### Interaction (click events)
```
click nodeId href "https://url" "tooltip"
click nodeId call callbackFn() "tooltip"
```
Requires `securityLevel: 'loose'`.

### Styling
```
style nodeId fill:#f9f,stroke:#333,stroke-width:4px,color:#fff,stroke-dasharray: 5 5
```

**classDef:**
```
classDef myClass fill:#f9f,stroke:#333,stroke-width:4px
class nodeId myClass
nodeId:::myClass
classDef default fill:#f9f   %% applies to all nodes without explicit class
```

### Node Text Features
- Unicode: `id["This ❤ Unicode"]`
- Markdown: `id["\`**Bold** _Italic_\`"]` (requires `htmlLabels: false`)
- Line breaks: `id["Line1<br/>Line2"]`

### Example
```
---
title: Authentication Flow
config:
  theme: default
---
flowchart TD
    A([Start]) --> B{Has account?}
    B -->|Yes| C[Login]
    B -->|No| D[Register]
    C --> E[(Database)]
    D --> E
    E --> F([End])
    style E fill:#bbf,stroke:#33f
    classDef decision fill:#ffd,stroke:#cc0
    class B decision
```

---

## 2. Sequence Diagram

**Keyword:** `sequenceDiagram`

### Participants
```
participant Alice
actor Bob
participant API@{ "type": "boundary" }          %% special types
participant DB@{ "type": "database" }
participant Ctrl@{ "type": "control" }
participant Ent@{ "type": "entity" }
participant Coll@{ "type": "collections" }
participant Q@{ "type": "queue" }
participant A as Alice                           %% alias with 'as' keyword
participant API@{ "type": "boundary", "alias": "Public API" }
```

### Grouping / Box
```
box Aqua Group Name
  participant A
  participant B
end
box rgb(33,66,99)
  participant C
end
box transparent Aqua   %% force transparent when name is a color
  participant D
end
```

### Message Arrow Types
| Arrow | Description |
|-------|-------------|
| `->` | Solid line, no arrowhead |
| `-->` | Dotted line, no arrowhead |
| `->>` | Solid line with arrowhead |
| `-->>` | Dotted line with arrowhead |
| `<<->>` | Solid bidirectional (v11+) |
| `<<-->>` | Dotted bidirectional (v11+) |
| `-x` | Solid line with cross |
| `--x` | Dotted line with cross |
| `-)` | Solid line, open arrow (async) |
| `--)` | Dotted line, open arrow (async) |
| `-\|\\` | Solid, top half arrowhead (v11.12.3+) |
| `--\|\\` | Dotted, top half arrowhead |
| `-\|/` | Solid, bottom half arrowhead |
| `--\|/` | Dotted, bottom half arrowhead |

### Message Syntax
```
Alice->>Bob: Message text
Alice->>+Bob: Message (activates Bob)
Bob-->>-Alice: Response (deactivates Bob)
```

### Central Connections (v11.12.3+)
```
Alice->>()Bob: from Alice to center
Alice()->>Bob: from center to Bob
John()->>()Alice: center to center
```

### Activations
```
activate Alice
deactivate Alice
%% or shorthand:
Alice->>+Bob: Message
Bob-->>-Alice: Reply
```

### Notes
```
Note right of Alice: Text
Note left of Bob: Text
Note over Alice,Bob: Spans two participants
```
Line breaks: `Note over A,B: Line 1<br/>Line 2`

### Fragments (Control Flow)
```
loop Every minute
  John-->Alice: Ping
end

alt is sick
  Bob->>Alice: Not great
else is well
  Bob->>Alice: Great!
end

opt Extra response
  Bob->>Alice: Thanks
end

par Alice to Bob
  Alice->>Bob: Hi!
and Alice to John
  Alice->>John: Hi!
end

critical Establish DB connection
  Service-->DB: connect
option Network timeout
  Service-->Service: Log error
option Credentials rejected
  Service-->Service: Log other error
end

break booking failed
  API-->Consumer: show failure
end

rect rgb(0,255,0)
  ... highlighted content ...
end
rect rgba(0,0,255,.1)
  ... content ...
end
```

### Dynamic Participants
```
create participant Carl
Alice->>Carl: Hi Carl!
create actor D as Donald
destroy Carl
Alice-xCarl: Goodbye
destroy Bob
Bob->>Alice: I agree
```

### Sequence Numbers
```
autonumber
Alice->>John: Message 1
John-->>Alice: Message 2
```

### Actor Menus / Links
```
link Alice: Dashboard @ https://dashboard.example.com/alice
links Alice: {"Dashboard": "https://example.com", "Wiki": "https://wiki.example.com"}
```

### Configuration
```javascript
mermaid.sequenceConfig = {
  mirrorActors: true,
  diagramMarginX: 50,
  diagramMarginY: 10,
  boxTextMargin: 5,
  noteMargin: 10,
  messageMargin: 35,
  actorFontSize: 14,
  actorFontFamily: '"Open Sans", sans-serif',
  noteFontSize: 14,
  messageFontSize: 16,
  bottomMarginAdj: 1,
};
```

### Example
```
sequenceDiagram
  autonumber
  participant C as Client
  participant A as API
  participant DB as Database
  C->>+A: POST /login
  A->>+DB: SELECT user
  DB-->>-A: User data
  A-->>-C: JWT token
  Note right of C: Store token
```

---

## 3. Class Diagram

**Keyword:** `classDiagram`

### Direction
```
classDiagram
  direction LR   %% TB | BT | LR | RL
```

### Define Classes
```
class Animal
class Animal["Animal with label"]
class `Animal Class!`        %% backtick for special chars

%% With members:
class BankAccount {
    +String owner
    +BigDecimal balance
    +deposit(amount) bool
    -withdraw(amount) int
    #protectedField
    ~packageField
    +staticMethod()$
    +abstractMethod()*
    List~int~ data           %% generics with ~
}

%% Colon syntax (one at a time):
BankAccount : +String owner
BankAccount : +deposit(amount)
```

### Visibility Modifiers
| Symbol | Meaning |
|--------|---------|
| `+` | Public |
| `-` | Private |
| `#` | Protected |
| `~` | Package/Internal |
| `*` (suffix) | Abstract |
| `$` (suffix) | Static |

### Annotations
```
class Shape <<interface>>
class Color <<enumeration>>
class Service <<Service>>
class Base <<Abstract>>

%% Or nested:
class Shape {
    <<interface>>
    +draw()
}
```

### Relationships
| Syntax | Type |
|--------|------|
| `ClassA <\|-- ClassB` | Inheritance |
| `ClassA *-- ClassB` | Composition |
| `ClassA o-- ClassB` | Aggregation |
| `ClassA --> ClassB` | Association |
| `ClassA -- ClassB` | Link (solid) |
| `ClassA ..> ClassB` | Dependency |
| `ClassA ..\|> ClassB` | Realization |
| `ClassA .. ClassB` | Link (dashed) |

**Labels and cardinality:**
```
ClassA "1" --> "*" ClassB : label text
ClassA <|--|> ClassB        %% two-way inheritance
```

**Lollipop interface:**
```
bar ()-- foo
foo --() bar
```

### Namespace
```
namespace BaseShapes {
  class Triangle
  class Rectangle {
    double width
    double height
  }
}
```

### Notes
```
note "General diagram note"
note for MyClass "Note for specific class"
```

### Interaction
```
link ClassName "https://url" "tooltip"
click ClassName call callbackFn() "tooltip"
click ClassName href "https://url" "tooltip"
```

### Styling
```
style Animal fill:#f9f,stroke:#333,stroke-width:4px
classDef myStyle fill:#f96,stroke:#333
class Animal myStyle
Animal:::myStyle           %% shorthand
classDef default fill:#f9f  %% applies to all
```

### Configuration
```yaml
config:
  class:
    hideEmptyMembersBox: true
```

### Example
```
classDiagram
  direction TB
  namespace Shapes {
    class Shape <<interface>> {
      +draw() void
      +area() float
    }
  }
  class Circle {
    +float radius
    +draw() void
    +area() float
  }
  class Rectangle {
    +float width
    +float height
    +draw() void
    +area() float
  }
  Shape <|.. Circle : implements
  Shape <|.. Rectangle : implements
  Circle "1" *-- "1" Point : center
```

---

## 4. State Diagram

**Keywords:** `stateDiagram-v2` (preferred) or `stateDiagram`

### States
```
stateDiagram-v2
  stateId                              %% simple state
  state "Description" as s2           %% state with description
  s2 : This is a state description    %% colon syntax
  [*] --> s1                          %% start state
  s1 --> [*]                          %% end state
```

### Transitions
```
s1 --> s2
s1 --> s2: Transition label
```

### Direction
```
direction LR   %% inside diagram or composite state
```

### Composite States
```
state First {
  [*] --> second
  second --> [*]
}

state "Named" as Named {
  [*] --> inner
}
```

### Special States
```
state if_state <<choice>>
state fork_state <<fork>>
state join_state <<join>>
```

### Concurrency
```
state Active {
  [*] --> NumLockOff
  NumLockOff --> NumLockOn : EvNumLockPressed
  --
  [*] --> CapsLockOff
  CapsLockOff --> CapsLockOn : EvCapsLockPressed
}
```

### Notes
```
note right of State1
  Important note here.
end note
note left of State2 : Inline note
```

### Styling (classDef)
```
classDef myStyle fill:#f00,color:white,font-weight:bold
class Still myStyle
class Moving, Crash movement
Still:::myStyle              %% shorthand in transition

%% Limitations: cannot style start/end states or composite states
```

### Example
```
stateDiagram-v2
  direction LR
  [*] --> Idle
  Idle --> Processing : start
  state Processing {
    direction TB
    [*] --> Fetching
    Fetching --> Parsing : data received
    Parsing --> [*]
  }
  Processing --> Done : success
  Processing --> Error : failure
  Error --> Idle : retry
  Done --> [*]
```

---

## 5. Entity Relationship Diagram

**Keyword:** `erDiagram`

### Relationship Syntax
```
ENTITY1 RELATIONSHIP ENTITY2 : "label"
```

### Cardinality Markers
| Left | Right | Meaning |
|------|-------|---------|
| `\|o` | `o\|` | Zero or one |
| `\|\|` | `\|\|` | Exactly one |
| `}o` | `o{` | Zero or more |
| `}\|` | `\|{` | One or more |

**Aliases:** `only one`, `1`, `zero or one`, `one or more`, `1+`, `zero or more`, `0+`, `many(0)`, `many(1)`

### Identification (line style)
| Syntax | Type |
|--------|------|
| `--` | Identifying (solid) |
| `..` | Non-identifying (dashed) |

**Aliases:** `to` = identifying, `optionally to` = non-identifying

### Full relationship examples:
```
CUSTOMER ||--o{ ORDER : places
CAR 1 to zero or more NAMED-DRIVER : allows
PERSON many(0) optionally to 0+ NAMED-DRIVER : is
```

### Attributes
```
ENTITY {
  string name
  int age
  string email PK "Primary key"
  string(99) firstName "Only 99 chars"
  string phone UK         %% Unique Key
  string orderId FK       %% Foreign Key
  string cardId PK, FK    %% Multiple keys
  string[] tags           %% array type
}
```

Keys: `PK`, `FK`, `UK` (comma-separated for multiple)

### Aliases (entity display names)
```
p[Person] {
  string firstName
}
a["Customer Account"] {
  string email
}
p ||--o| a : has
```

### Direction
```
erDiagram
  direction LR   %% TB | BT | LR | RL
```

### Styling
```
style id1 fill:#f9f,stroke:#333
classDef myClass fill:#f96
class ENTITY myClass
ENTITY:::myClass
classDef default fill:#f9f
```

### Example
```
erDiagram
  direction LR
  CUSTOMER ||--o{ ORDER : places
  CUSTOMER {
    string id PK
    string name
    string email UK
  }
  ORDER ||--|{ LINE-ITEM : contains
  ORDER {
    int orderNumber PK
    string customerId FK
    date orderDate
  }
  PRODUCT ||--o{ LINE-ITEM : "ordered in"
  PRODUCT {
    string code PK
    string name
    float price
  }
```

---

## 6. Gantt Diagram

**Keyword:** `gantt`

### Structure
```
gantt
  title Chart Title
  dateFormat YYYY-MM-DD
  axisFormat %m/%d
  tickInterval 1week
  weekday monday
  excludes weekends
  excludes 2024-01-01, sunday
  weekend friday      %% define weekend start (friday or saturday)
  todayMarker off     %% or: todayMarker stroke-width:5px,stroke:#0f0,opacity:0.5
  displayMode compact %% (or via frontmatter: displayMode: compact)

  section Section Name
    Task Name   : [tags,] [id,] startDate, endDate/duration
```

### Task Metadata Syntax
```
Task : a1, 2024-01-01, 30d           %% id, start, duration
Task : after a1, 20d                 %% after another task
Task : 2024-01-01, 2024-02-01        %% start, end date
Task : 2024-01-01, until b           %% start until another task starts
Task : crit, active, a1, 2024-01-01, 3d   %% with tags
Task : milestone, m1, 2024-01-25, 0d      %% milestone
Task : vert, v1, 2024-01-15, 0d           %% vertical marker
```

**Tags (optional, specified first):** `active`, `done`, `crit`, `milestone`, `vert`

### Date Formats (dateFormat)
| Token | Meaning |
|-------|---------|
| `YYYY` | 4-digit year |
| `YY` | 2-digit year |
| `MM` | Month (01-12) |
| `DD` | Day (01-31) |
| `HH` | Hour 24h (00-23) |
| `hh` | Hour 12h (01-12) |
| `mm` | Minutes |
| `ss` | Seconds |
| `X` | Unix timestamp |
| `x` | Unix ms timestamp |

### Axis Formats (axisFormat — d3 strftime)
`%Y` year, `%m` month, `%d` day, `%H` hour, `%M` minute, `%b` short month, `%a` short weekday

### tickInterval
Pattern: `[1-9][0-9]*(millisecond|second|minute|hour|day|week|month)`

### Configuration
```javascript
mermaid.ganttConfig = {
  titleTopMargin: 25,
  barHeight: 20,
  barGap: 4,
  topPadding: 75,
  rightPadding: 75,
  leftPadding: 75,
  fontSize: 12,
  sectionFontSize: 24,
  numberSectionStyles: 4,
  axisFormat: '%d/%m',
  tickInterval: '1week',
  topAxis: true,
  displayMode: 'compact',
  weekday: 'sunday',
};
```

### Interaction
```
click taskId href "https://url"
click taskId call callbackFn(args)
```

### Example
```
gantt
  title Project Timeline
  dateFormat YYYY-MM-DD
  axisFormat %b %d
  excludes weekends

  section Planning
    Requirements   : done, req, 2024-01-01, 7d
    Design         : active, des, after req, 14d

  section Development
    Backend API    : crit, back, after des, 21d
    Frontend       : front, after des, 21d
    Integration    : after back front, 7d

  section Release
    Testing        : crit, 7d
    Deploy         : milestone, 2024-03-15, 0d
```

---

## 7. Pie Chart

**Keyword:** `pie`

### Syntax
```
pie [showData] [title "Title Text"]
  "Label A" : 42.5
  "Label B" : 30
  "Label C" : 27.5
```
- Values must be positive numbers > 0
- `showData` renders actual values next to labels

### Configuration
```yaml
config:
  pie:
    textPosition: 0.75   %% 0.0 (center) to 1.0 (outer edge)
  themeVariables:
    pieOuterStrokeWidth: "5px"
```

### Example
```
---
config:
  pie:
    textPosition: 0.5
---
pie showData
  title Browser Market Share
  "Chrome" : 65.5
  "Safari" : 19.2
  "Firefox" : 4.0
  "Edge" : 4.1
  "Other" : 7.2
```

---

## 8. Quadrant Chart

**Keyword:** `quadrantChart`

### Syntax
```
quadrantChart
  title Chart Title
  x-axis Low Label --> High Label
  x-axis "Left Label Only"         %% single label
  y-axis Bottom Label --> Top Label
  quadrant-1 Top-right text         %% Q1 = top right
  quadrant-2 Top-left text          %% Q2 = top left
  quadrant-3 Bottom-left text       %% Q3 = bottom left
  quadrant-4 Bottom-right text      %% Q4 = bottom right
  Point A: [0.75, 0.80]             %% x,y in range 0-1
  Point B:::myClass: [0.3, 0.5]     %% with class
  Point C: [0.5, 0.5] radius: 12, color: #ff0000, stroke-color: #000, stroke-width: 2px
```

### Point Styling
```
Point A: [0.9, 0.0] radius: 12
Point B: [0.8, 0.1] color: #ff3300, radius: 10
classDef myClass color: #109060, radius: 10
Point C:::myClass: [0.5, 0.5]
```

### Configuration
```yaml
config:
  quadrantChart:
    chartWidth: 500
    chartHeight: 500
    titlePadding: 10
    titleFontSize: 20
    quadrantPadding: 5
    quadrantLabelFontSize: 16
    pointRadius: 5
    pointLabelFontSize: 12
    xAxisPosition: top        %% top | bottom
    yAxisPosition: left       %% left | right
  themeVariables:
    quadrant1Fill: "#ff0000"
    quadrant2Fill: "#00ff00"
    quadrant3Fill: "#0000ff"
    quadrant4Fill: "#ffff00"
    quadrantPointFill: "#ff00ff"
    quadrantTitleFill: "#000000"
```

### Example
```
quadrantChart
  title Eisenhower Matrix
  x-axis Urgent --> Not Urgent
  y-axis Not Important --> Important
  quadrant-1 Plan
  quadrant-2 Do
  quadrant-3 Delegate
  quadrant-4 Delete
  Email: [0.9, 0.3]
  Meeting: [0.8, 0.7]
  Exercise: [0.2, 0.9]
  Social media: [0.1, 0.1]
```

---

## 9. Requirement Diagram

**Keyword:** `requirementDiagram`

### Requirement Types
`requirement` | `functionalRequirement` | `interfaceRequirement` | `performanceRequirement` | `physicalRequirement` | `designConstraint`

### Risk Options
`Low` | `Medium` | `High`

### Verify Methods
`Analysis` | `Inspection` | `Test` | `Demonstration`

### Syntax
```
requirementDiagram

direction LR   %% TB | BT | LR | RL

requirement req_name {
  id: 1
  text: requirement description
  risk: high
  verifymethod: test
}

functionalRequirement func_req {
  id: 1.1
  text: "functional requirement"
  risk: low
  verifymethod: inspection
}

element element_name {
  type: simulation
  docRef: path/to/doc
}

req_name - satisfies -> element_name
element_name <- copies - other_elem
```

**Relationship types:** `contains` | `copies` | `derives` | `satisfies` | `verifies` | `refines` | `traces`

### Styling
```
style req_name fill:#ffa,stroke:#000,color:green
classDef important fill:#f96,stroke:#333,font-weight:bold
class req_name,elem_name important
req_name:::important
```

### Example
```
requirementDiagram

requirement sys_req {
  id: 1
  text: System shall process 1000 req/s
  risk: high
  verifymethod: test
}

performanceRequirement perf_req {
  id: 1.1
  text: Response time < 100ms
  risk: medium
  verifymethod: demonstration
}

element load_test {
  type: "test suite"
  docRef: tests/load_test
}

load_test - verifies -> perf_req
sys_req - contains -> perf_req
```

---

## 10. GitGraph

**Keyword:** `gitGraph`

### Commands
```
gitGraph
  commit                                %% normal commit on current branch
  commit id: "custom-id"
  commit id: "tag" tag: "v1.0.0"
  commit type: NORMAL                   %% NORMAL | REVERSE | HIGHLIGHT
  commit id: "A" tag: "release" type: HIGHLIGHT
  branch develop
  branch "cherry-pick"                  %% quoted if could be keyword
  checkout develop
  switch develop                        %% same as checkout
  merge develop
  merge develop id: "merge-id" tag: "merge-tag" type: REVERSE
  cherry-pick id: "commit-id"
  cherry-pick id: "merge-id" parent: "parent-commit-id"
```

### Configuration (via frontmatter)
```yaml
config:
  gitGraph:
    showBranches: true
    showCommitLabel: true
    mainBranchName: main
    mainBranchOrder: 0
    parallelCommits: false
    rotateCommitLabel: true
```

### Theming
```yaml
config:
  theme: base
  themeVariables:
    git0: "#ff0000"
    git1: "#00ff00"
    gitBranchLabel0: "#ffffff"
    commitLabelBackground: "#f4f4f4"
    commitLabelColor: "#000000"
    commitLabelFontSize: "16px"
    tagLabelFontSize: "14px"
    tagLabelBackground: "#fff"
    tagLabelBorder: "#ccc"
    tagLabelColor: "#000"
```

### Example
```
---
title: Feature Branch Workflow
---
gitGraph
  commit id: "init"
  branch develop
  checkout develop
  commit id: "feature-start"
  branch feature/auth
  checkout feature/auth
  commit id: "add-login"
  commit id: "add-logout"
  checkout develop
  merge feature/auth id: "merge-auth" tag: "v0.2"
  checkout main
  merge develop id: "release" tag: "v1.0.0" type: HIGHLIGHT
```

---

## 11. Mindmap

**Keyword:** `mindmap`

### Syntax (indentation-based hierarchy)
```
mindmap
  root((Central Topic))
    Branch A
      Leaf 1
      Leaf 2
    Branch B
      ::icon(fa fa-book)
      :::myClass
      Sub-branch
        Deep leaf
```

### Node Shapes
| Syntax | Shape |
|--------|-------|
| `id[text]` | Square |
| `id(text)` | Rounded square |
| `id((text))` | Circle |
| `id))text((` | Bang (cloud-like) |
| `id)text(` | Cloud |
| `id{{text}}` | Hexagon |
| `text` (plain) | Default (rounded rectangle) |

### Icons (requires font icons loaded by integrator)
```
Node
  ::icon(fa fa-book)
  ::icon(mdi mdi-skull-outline)
```

### CSS Classes
```
Node[Text]
  :::className1 className2
```

### Markdown Strings
```
mindmap
  id1["`**Bold** and _italic_`"]
    id2["`Long text wraps
    automatically`"]
```

### Layout
```yaml
config:
  layout: tidy-tree   %% requires tidy-tree plugin registration
```

### Example
```
mindmap
  root((Project))
    Planning
      ::icon(fa fa-calendar)
      Requirements
      Timeline
    Development
      ::icon(fa fa-code)
      Backend
        API
        Database
      Frontend
        UI
        Tests
    Deployment
      Staging
      Production
```

---

## 12. Timeline

**Keyword:** `timeline`

### Syntax
```
timeline
  title Timeline Title
  section Section Name
    TimePeriod : Event 1 : Event 2
    TimePeriod2 : Event
               : Another event on same period
```
- Time periods and events are plain text
- Multiple events per period: separate with `:` or new lines (same indent, leading `:`)
- Line breaks: use `<br>`

### Styling
```yaml
config:
  theme: base
  timeline:
    disableMulticolor: true   %% all periods same color
  themeVariables:
    cScale0: '#ff0000'
    cScaleLabel0: '#ffffff'
    cScale1: '#00ff00'
    cScale2: '#0000ff'
    %% cScale0..cScale11, cScaleLabel0..cScaleLabel11
```

### Example
```
timeline
  title Technology Timeline
  section Early Computing
    1940s : First computers
          : ENIAC developed
    1950s : Transistors
          : FORTRAN language
  section Personal Computing
    1970s : Microprocessors
          : Apple I
    1980s : IBM PC
          : Macintosh
  section Internet Era
    1990s : World Wide Web
          : Browser wars
    2000s : Social media
          : Smartphones
```

---

## 13. Sankey Diagram

**Keyword:** `sankey` (v10.3.0+)

### Syntax (CSV-like format)
```
sankey

source,target,value
Source A,Target B,100
Source A,Target C,50
"Source, with comma","Target D",75
"Source with ""quotes""","Target E",25
```

Rules:
- 3 columns only: `source`, `target`, `value`
- Empty lines allowed for readability
- Wrap commas in double quotes
- Escape double quotes by doubling them

### Configuration
```yaml
config:
  sankey:
    showValues: false    %% hide/show value labels
    width: 800
    height: 400
    linkColor: source    %% source | target | gradient | #hex
    nodeAlignment: justify  %% justify | center | left | right
```

### Example
```
---
config:
  sankey:
    showValues: false
---
sankey

Electricity,Homes,113
Electricity,Industry,342
Electricity,Transport,37

Gas,Heating,152
Gas,Industry,48
```

---

## 14. XY Chart

**Keyword:** `xychart`

### Syntax
```
xychart [horizontal]
  title "Chart Title"
  x-axis [jan, feb, mar]                      %% categorical
  x-axis "X Title" 0 --> 100                  %% numeric range
  y-axis "Y Title" 0 --> 100
  y-axis "Y Title"                             %% auto range
  bar [10, 20, 30, 40]
  line [15, 25, 35, 45]
```

### Configuration
```yaml
config:
  xyChart:
    width: 700
    height: 500
    titlePadding: 10
    titleFontSize: 20
    showTitle: true
    chartOrientation: vertical     %% vertical | horizontal
    plotReservedSpacePercent: 50
    showDataLabel: false
    xAxis:
      showLabel: true
      labelFontSize: 14
      showTitle: true
      titleFontSize: 16
      showTick: true
      tickLength: 5
      showAxisLine: true
    yAxis:
      showLabel: true
      labelFontSize: 14
  themeVariables:
    xyChart:
      backgroundColor: "#ffffff"
      titleColor: "#333333"
      xAxisLabelColor: "#555"
      xAxisTitleColor: "#333"
      xAxisTickColor: "#999"
      xAxisLineColor: "#999"
      yAxisLabelColor: "#555"
      yAxisTitleColor: "#333"
      yAxisTickColor: "#999"
      yAxisLineColor: "#999"
      plotColorPalette: "#ff0000, #00ff00, #0000ff"
```

### Example
```
---
config:
  xyChart:
    width: 800
    showDataLabel: true
  themeVariables:
    xyChart:
      plotColorPalette: "#4e79a7, #f28e2b"
---
xychart
  title "Quarterly Revenue"
  x-axis [Q1, Q2, Q3, Q4]
  y-axis "Revenue ($M)" 0 --> 50
  bar [20, 28, 35, 42]
  line [18, 25, 33, 40]
```

---

## 15. Block Diagram

**Keyword:** `block`

### Syntax
```
block
  columns 3
  a b c d         %% 4 blocks, 3 columns → d wraps to row 2
  a["Label"] b:2  %% b spans 2 columns
  space           %% empty cell (1 column)
  space:3         %% empty cell spanning 3 columns
```

### Nested (Composite) Blocks
```
block
  block:groupId:2        %% id:columnSpan
    columns 2
    A B C D
  end
  E
```

### Block Shapes
Same as flowchart node shapes:
- `id[text]` rectangle
- `id(text)` rounded
- `id([text])` stadium
- `id[[text]]` subroutine
- `id[(text)]` cylinder
- `id((text))` circle
- `id>text]` asymmetric
- `id{text}` rhombus
- `id{{text}}` hexagon
- `id[/text/]` parallelogram
- `id[\text\]` parallelogram alt
- `id[/text\]` trapezoid
- `id[\text/]` trapezoid alt
- `id(((text)))` double circle

### Block Arrows
```
blockArrowId<["Label"]>(right)
blockArrowId2<["Label"]>(left)
blockArrowId3<["Label"]>(up)
blockArrowId4<["Label"]>(down)
blockArrowId5<["Label"]>(x)     %% horizontal bidirectional
blockArrowId6<["Label"]>(y)     %% vertical bidirectional
blockArrowId7<["Label"]>(x, down)
```

### Connections
```
block
  A space B
  A --> B
  A -- "label" --> B
  A --- B      %% no arrowhead
```

### Styling
```
style B fill:#969,stroke:#333,stroke-width:4px
classDef myClass fill:#6e6ce6,stroke:#333
class A myClass
```

### Example
```
block
  columns 3
  Frontend blockArrowId<[" "]>(right) Backend
  space:2 down<[" "]>(down)
  Disk left<[" "]>(left) Database[("Database")]

  classDef front fill:#696,stroke:#333
  classDef back fill:#969,stroke:#333
  class Frontend front
  class Backend,Database back
```

---

## 16. Kanban

**Keyword:** `kanban`

### Syntax
```
kanban
  columnId[Column Title]
    taskId[Task Description]
    taskId2[Another Task]@{ ticket: PROJ-123, assigned: 'user', priority: 'High' }
```

**Priority values:** `Very High` | `High` | `Low` | `Very Low`

### Configuration
```yaml
config:
  kanban:
    ticketBaseUrl: 'https://jira.example.com/browse/#TICKET#'
```
`#TICKET#` is replaced by the task's ticket value.

### Example
```
---
config:
  kanban:
    ticketBaseUrl: 'https://github.com/org/repo/issues/#TICKET#'
---
kanban
  todo[To Do]
    id1[Write unit tests]@{ ticket: 42, priority: 'High' }
    id2[Update documentation]@{ assigned: 'alice' }
  wip[In Progress]
    id3[Implement feature]@{ ticket: 38, assigned: 'bob', priority: 'Very High' }
  review[Review]
    id4[Code review for PR #45]
  done[Done]
    id5[Fix login bug]@{ ticket: 31 }
```

---

## 17. Architecture Diagram

**Keyword:** `architecture-beta` (v11.1.0+)

### Syntax
```
architecture-beta
  group groupId(iconName)[Label]
  group subGroupId(iconName)[Label] in parentGroupId

  service serviceId(iconName)[Label]
  service serviceId(iconName)[Label] in groupId

  junction junctionId
  junction junctionId in groupId

  serviceId:L -- R:serviceId2           %% edge (T=Top, B=Bottom, L=Left, R=Right)
  serviceId:T --> B:serviceId2          %% with arrow into target
  serviceId:L <-- R:serviceId2          %% with arrow into source
  serviceId:L <--> R:serviceId2         %% bidirectional
  serviceId{group}:B --> T:serviceId2{group}   %% edges out of groups
```

### Built-in Icons
`cloud` | `database` | `disk` | `internet` | `server`

Custom icons via iconify: `logos:aws-lambda`, `logos:aws-aurora`, etc.

### Example
```
architecture-beta
  group cloud(cloud)[AWS Cloud]

  service lb(internet)[Load Balancer] in cloud
  service api1(server)[API Server 1] in cloud
  service api2(server)[API Server 2] in cloud
  service db(database)[RDS Database] in cloud
  service cache(disk)[ElastiCache] in cloud

  lb:R --> L:api1
  lb:R --> L:api2
  api1:R --> L:db
  api2:R --> L:db
  api1:B --> T:cache
  api2:B --> T:cache
```

---

## 18. Packet Diagram

**Keyword:** `packet` (v11.0.0+)

### Syntax
```
---
title: "TCP Packet"
---
packet
0-15: "Source Port"
16-31: "Destination Port"
32-63: "Sequence Number"
106: "URG"          %% single bit
107: "ACK"

%% v11.7.0+ bit-count syntax:
+16: "Source Port"   %% 16 bits from previous field end
+16: "Dest Port"
32-47: "Length"      %% can mix styles
```

### Example
```
packet
title UDP Packet
+16: "Source Port"
+16: "Destination Port"
+16: "Length"
+16: "Checksum"
64-95: "Data (variable)"
```

---

## 19. C4 Diagrams

**Keywords:** `C4Context` | `C4Container` | `C4Component` | `C4Dynamic` | `C4Deployment`

### Elements

**Context (C4Context):**
```
Person(alias, label, ?descr)
Person_Ext(alias, label, ?descr)
System(alias, label, ?descr)
SystemDb(alias, label, ?descr)
SystemQueue(alias, label, ?descr)
System_Ext(alias, label, ?descr)
SystemDb_Ext(alias, label, ?descr)
SystemQueue_Ext(alias, label, ?descr)
```

**Container (C4Container):**
```
Container(alias, label, ?techn, ?descr)
ContainerDb(alias, label, ?techn, ?descr)
ContainerQueue(alias, label, ?techn, ?descr)
Container_Ext / ContainerDb_Ext / ContainerQueue_Ext
```

**Component (C4Component):**
```
Component(alias, label, ?techn, ?descr)
ComponentDb / ComponentQueue / Component_Ext / ComponentDb_Ext / ComponentQueue_Ext
```

**Deployment (C4Deployment):**
```
Deployment_Node(alias, label, ?type, ?descr)
Node(alias, label, ?type, ?descr)       %% alias for Deployment_Node
Node_L / Node_R
```

**Boundaries:**
```
Enterprise_Boundary(alias, label) { ... }
System_Boundary(alias, label) { ... }
Container_Boundary(alias, label) { ... }
Boundary(alias, label, type) { ... }
```

### Relationships
```
Rel(from, to, label, ?techn)
BiRel(from, to, label)
RelIndex(index, from, to, label)        %% C4Dynamic
Rel_U / Rel_Up / Rel_D / Rel_Down
Rel_L / Rel_Left / Rel_R / Rel_Right
Rel_Back(from, to, label)
```

### Styling
```
UpdateElementStyle(alias, $fontColor="red", $bgColor="grey", $borderColor="red")
UpdateRelStyle(from, to, $textColor="blue", $lineColor="blue", $offsetX="5", $offsetY="-10")
UpdateLayoutConfig($c4ShapeInRow="4", $c4BoundaryInRow="2")
```

### Example
```
C4Container
title Container Diagram

System_Ext(extMail, "E-Mail System", "SMTP")
Person(user, "User", "End user")

Container_Boundary(sys, "Application") {
  Container(web, "Web App", "React", "Single-page application")
  Container(api, "API", "Node.js", "REST API")
  ContainerDb(db, "Database", "PostgreSQL", "User data")
}

Rel(user, web, "Uses", "HTTPS")
Rel(web, api, "Calls", "JSON/HTTPS")
Rel(api, db, "Reads/Writes", "SQL")
Rel(api, extMail, "Sends email", "SMTP")
UpdateRelStyle(user, web, $offsetY="20")
```

---

## 20. ZenUML (Sequence Alternative)

**Keyword:** `zenuml`

### Syntax
```
zenuml
  title Title
  Alice                          %% declare participant
  @Actor Bob                     %% annotator types: @Actor @Database @Boundary @Control @Entity @Queue
  A as Alice                     %% alias
  J as John

  Alice->Bob: async message
  Alice.SyncMethod()             %% sync call to self
  Alice.SyncMethod(p1, p2) {    %% sync with body
    Bob.nestedMethod()
  }
  new ObjectA                    %% creation message
  new ObjectA(with, params)

  %% Reply messages:
  a = Alice.method()             %% assign return value
  SomeType a = Alice.method()    %% typed variable
  Alice.method() {
    return result                %% explicit return
  }
  @return
  Alice->Bob: returnValue        %% @return annotator
```

### Control Flow
```
while(condition) {
  ...
}

for(item in list) {
  ...
}

forEach(item in collection) {
  ...
}

loop loopText {
  ...
}

if(condition) {
  ...
} else if(cond2) {
  ...
} else {
  ...
}

opt {
  ...
}

par {
  Alice->Bob: parallel1
  Alice->John: parallel2
}

try {
  ...
} catch {
  ...
} finally {
  ...
}
```

### Comments
```
// Single-line comment (rendered above next message)
// **Markdown** supported in comments
```

### Example
```
zenuml
  title Order Processing
  @Actor Customer
  @Database OrderDB

  Customer->OrderService: placeOrder(items)
  OrderService.validateOrder(items) {
    if(items.isEmpty()) {
      return error
    }
  }
  OrderService->OrderDB: save(order)
  order = OrderDB.save(order) {}
  return order
```

---

## 21. Radar Diagram

**Keyword:** `radar-beta` (v11.6.0+)

### Syntax
```
radar-beta
  title Title Text
  axis id1["Label 1"]
  axis id2["Label 2"], id3["Label 3"]   %% multiple on one line
  curve c1["Curve Name"]{1, 2, 3, 4, 5}
  curve c2{5, 4, 3, 2, 1}
  curve c3{ axis1: 30, axis2: 20 }     %% key-value pairs
  showLegend true
  max 100
  min 0
  graticule circle    %% circle | polygon
  ticks 5
```

### Configuration
```yaml
config:
  radar:
    width: 600
    height: 600
    marginTop: 50
    marginBottom: 50
    marginLeft: 50
    marginRight: 50
    axisScaleFactor: 1
    axisLabelFactor: 1.05
    curveTension: 0.17
  themeVariables:
    cScale0: "#FF0000"
    cScale1: "#00FF00"
    radar:
      axisColor: "black"
      axisStrokeWidth: 1
      axisLabelFontSize: "12px"
      curveOpacity: 0.7
      curveStrokeWidth: 2
      graticuleColor: "black"
      graticuleOpacity: 0.5
      graticuleStrokeWidth: 1
      legendBoxSize: 10
      legendFontSize: "14px"
```

### Example
```
---
title: "Team Skill Assessment"
---
radar-beta
  axis tech["Technical"], comm["Communication"], lead["Leadership"]
  axis prob["Problem Solving"], collab["Collaboration"]
  curve alice["Alice"]{85, 70, 60, 90, 75}
  curve bob["Bob"]{70, 85, 80, 75, 90}
  max 100
  min 0
  graticule polygon
  ticks 5
```

---

## 22. Treemap

**Keyword:** `treemap-beta`

### Syntax (indentation = hierarchy)
```
treemap-beta
"Section 1"
    "Leaf 1.1": 12           %% leaf with value
    "Section 1.2":::myClass  %% section with style
      "Leaf 1.2.1": 8
"Section 2"
    "Leaf 2.1": 20:::myClass %% leaf with style
    "Leaf 2.2": 25

classDef myClass fill:red,color:blue,stroke:#FFD600
```

### Configuration
```yaml
config:
  treemap:
    useMaxWidth: true
    padding: 10
    diagramPadding: 8
    showValues: true
    borderWidth: 1
    valueFontSize: 12
    labelFontSize: 14
    valueFormat: ","       %% d3 format: "," | "$" | ".1f" | ".1%" | "$0,0" | "$,.2f"
```

### Example
```
---
config:
  treemap:
    valueFormat: '$0,0'
---
treemap-beta
"Budget 2024"
    "Engineering"
        "Salaries": 1200000
        "Tools": 50000
    "Marketing"
        "Campaigns": 300000
        "Events": 150000
    "Operations"
        "Infrastructure": 200000
```

---

## 23. Venn Diagram

**Keyword:** `venn-beta` (v11.12.3+)

### Syntax
```
venn-beta
  title "Title"
  set A["Set A Name"]:20        %% :N sets size
  set B["Set B Name"]:12
  union A,B["Overlap Label"]:5  %% identifiers must be previously defined
  text A1["Item in A"]          %% text node in set A (indented under set/union)
  union A,B,C["Triple overlap"]
  style A fill:#ff6b6b
  style A,B color:#333
  style AB1 color:red
```

**Style properties:** `fill`, `color`, `stroke`, `stroke-width`, `fill-opacity`

### Example
```
venn-beta
  title "Technology Skills"
  set frontend["Frontend"]:30
    text f1["React"]
    text f2["CSS"]
  set backend["Backend"]:25
    text b1["Node.js"]
    text b2["SQL"]
  union frontend,backend["Fullstack"]:10
    text fb1["TypeScript"]
  style frontend fill:#4fc3f7
  style backend fill:#81c784
```

---

## 24. User Journey

**Keyword:** `journey`

### Syntax
```
journey
  title Journey Title
  section Section Name
    Task Name: score: Actor1, Actor2
```

- `score`: integer 1–5 (satisfaction level)
- Multiple actors comma-separated
- Tasks assigned to all listed actors

### Example
```
journey
  title User Onboarding
  section Discovery
    Find product: 3: User
    Visit homepage: 4: User
  section Signup
    Create account: 2: User, System
    Verify email: 3: User, System
  section First Use
    Complete profile: 4: User
    First action: 5: User
    Get help: 2: User, Support
```

---

## Global Styling Reference

### `style` keyword (inline CSS on individual nodes)
```
style nodeId fill:#f9f,stroke:#333,stroke-width:4px,color:#fff,stroke-dasharray: 5 5,font-size:16px
```

### `classDef` (reusable style class)
```
classDef className fill:#f9f,stroke:#333,stroke-width:4px,color:#fff
classDef class1,class2 font-size:12pt   %% multiple classes same style
classDef default fill:#f9f             %% applies to all nodes by default
```

### Applying classes
```
class nodeId className
class nodeId1,nodeId2 className
nodeId:::className                     %% shorthand
nodeId:::class1,class2                 %% multiple classes
```

### CSS Properties commonly used
`fill`, `stroke`, `stroke-width`, `stroke-dasharray`, `color`, `font-size`, `font-weight`, `font-style`, `opacity`, `rx`, `ry`

---

## Theme Variables

### Global themeVariables
```yaml
config:
  themeVariables:
    primaryColor: '#ff0000'
    primaryTextColor: '#ffffff'
    primaryBorderColor: '#cc0000'
    lineColor: '#333333'
    secondaryColor: '#00ff00'
    tertiaryColor: '#0000ff'
    background: '#ffffff'
    mainBkg: '#ececff'
    secondBkg: '#f4f4f4'
    border1: '#9370db'
    border2: '#aaaa33'
    arrowheadColor: '#333333'
    fontFamily: '"trebuchet ms", verdana, arial'
    fontSize: '16px'
    labelBackground: '#e8e8e8'
    edgeLabelBackground: '#e8e8e8'
    clusterBkg: '#ffffde'
    clusterBorder: '#aaaa33'
    titleColor: '#333'
    attributeBackgroundColorEven: '#fff'
    attributeBackgroundColorOdd: '#f8f8f8'
    noteBkgColor: '#fff5ad'
    noteTextColor: '#333'
    activationBorderColor: '#666'
    activationBkgColor: '#f4f4f4'
    sequenceNumberColor: 'white'
    sectionBkgColor: '#6eaa28'
    altSectionBkgColor: 'white'
    gridColor: 'lightgrey'
    fillType0: '#6eaa28' # ... fillType0 through fillType7
    cScale0: '#ff0000'   # cScale0..cScale11
    cScaleLabel0: '#ffffff'
```

---

## Quick Reference Card

| Diagram | Keyword | Min Required |
|---------|---------|-------------|
| Flowchart | `flowchart LR` | direction + one node |
| Sequence | `sequenceDiagram` | one message |
| Class | `classDiagram` | one class |
| State | `stateDiagram-v2` | one state |
| ER | `erDiagram` | one entity |
| Gantt | `gantt` | `dateFormat` + one task |
| Pie | `pie` | one slice |
| Quadrant | `quadrantChart` | one point |
| Requirement | `requirementDiagram` | one requirement |
| GitGraph | `gitGraph` | one commit |
| Mindmap | `mindmap` | root node |
| Timeline | `timeline` | one period |
| Sankey | `sankey` | one CSV row |
| XY Chart | `xychart` | one data series |
| Block | `block` | one block |
| Kanban | `kanban` | one column |
| Architecture | `architecture-beta` | one service |
| Packet | `packet` | one field |
| C4 Context | `C4Context` | one element |
| ZenUML | `zenuml` | one message |
| Radar | `radar-beta` | one axis + one curve |
| Treemap | `treemap-beta` | one leaf with value |
| Venn | `venn-beta` | one set |
| User Journey | `journey` | one task in a section |

---

## Economics-Specific Examples (Enhanced)

> 강의노트/학술 자료에서 자주 사용되는 경제학 다이어그램 예시.
> 모든 예시에 classDef 팔레트 + ELK layout 적용.

### Economics Palette (공통 classDef)
```
classDef primary fill:#3b82f6,stroke:#1e3a5f,color:#fff
classDef secondary fill:#8b5cf6,stroke:#5b21b6,color:#fff
classDef market fill:#fed7aa,stroke:#c2410c
classDef game fill:#ddd6fe,stroke:#6d28d9
classDef success fill:#bbf7d0,stroke:#166534
classDef warning fill:#fef08a,stroke:#854d0e
classDef danger fill:#fecaca,stroke:#991b1b
classDef neutral fill:#e5e7eb,stroke:#374151
```

### Example: 경제학 기본 흐름 (Flowchart + ELK)
```
---
title: "경제학의 기본 흐름"
config:
  layout: elk
  theme: base
---
flowchart LR
    subgraph S1 ["1. 합리적 의사결정"]
        A1(소비자) & A2(생산자) & A3(정부)
    end
    subgraph S2 ["2. 상호작용"]
        B1(시장) & B2(게임이론)
    end
    subgraph S3 ["3. 균형 & 문제해결"]
        C1(균형 도출) & C2(정책 개선)
    end
    S1 ==> S2 ==> S3
    classDef primary fill:#3b82f6,stroke:#1e3a5f,color:#fff
    class A1,A2,A3,B1,B2,C1,C2 primary
```

### Example: 미시경제학 두 접근법
```
---
config:
  layout: elk
  theme: base
---
flowchart TB
    Micro[미시경제학] --> Market[시장 분석<br/>경제주체 다수]
    Micro --> Game[게임이론<br/>경제주체 소수]
    Market --> Eq[수요·공급 → 균형]
    Game --> Nash[Nash Equilibrium]
    classDef market fill:#fed7aa,stroke:#c2410c
    classDef game fill:#ddd6fe,stroke:#6d28d9
    class Market market
    class Game game
```

### Example: 한계분석 MB=MC (Flowchart 버전)
```
---
title: "한계분석 MB = MC"
config:
  layout: elk
  theme: base
---
flowchart TB
    subgraph Analysis ["한계분석 프레임워크"]
        direction TB
        Q["활동량 Q"] --> MB["한계편익 MB<br/>(감소 함수)"]
        Q --> MC["한계비용 MC<br/>(증가 함수)"]
        MB & MC --> Compare{"MB vs MC"}
        Compare -->|"MB > MC"| Increase["활동량 증가"]
        Compare -->|"MB < MC"| Decrease["활동량 감소"]
        Compare -->|"MB = MC"| Optimal["최적점 Q*"]
    end
    classDef primary fill:#3b82f6,stroke:#1e3a5f,color:#fff
    classDef success fill:#bbf7d0,stroke:#166534
    class Q,MB,MC primary
    class Optimal success
```

### Example: MB=MC (XY Chart 버전)
```
xychart-beta
  title "MB vs MC"
  x-axis "활동량 Q" [0, 2, 4, 6, 8, 10]
  y-axis "한계편익/비용" [0, 12]
  line "MB (감소)" [11, 8.5, 6.5, 4.5, 3, 1.5]
  line "MC (증가)" [1.5, 3, 4.5, 6.5, 8.5, 11]
```

### Example: 소비자 선호 가정
```
---
config:
  layout: elk
  theme: base
---
flowchart TB
    Pref["소비자 선호 가정"] --> Comp["완비성<br/>Completeness"]
    Pref --> Trans["이행성<br/>Transitivity"]
    Pref --> More["단조성<br/>More is Better"]
    Comp --> CompDesc["모든 묶음 비교 가능"]
    Trans --> TransDesc["A ≻ B, B ≻ C → A ≻ C"]
    More --> MoreDesc["더 많은 것을 선호"]
    classDef primary fill:#3b82f6,stroke:#1e3a5f,color:#fff
    classDef neutral fill:#e5e7eb,stroke:#374151
    class Pref,Comp,Trans,More primary
    class CompDesc,TransDesc,MoreDesc neutral
```

### Example: 소비자 최적화 문제
```
---
title: "소비자 최적화 문제"
config:
  layout: elk
  theme: base
---
flowchart TB
    subgraph Objective ["목적"]
        Max["max U(x1, x2)<br/>효용 극대화"]
    end
    subgraph Constraint ["제약"]
        Budget["p1*x1 + p2*x2 <= M<br/>예산 제약"]
        NonNeg["x1, x2 >= 0"]
    end
    subgraph Solution ["해법"]
        Tangency["MRS = p1/p2<br/>접선 조건"]
        Corner["꼭짓점 해"]
    end
    Max --> Budget
    Budget --> Tangency
    Budget --> Corner
    Tangency --> Optimal["최적 소비 묶음"]
    Corner --> Optimal
    classDef primary fill:#3b82f6,stroke:#1e3a5f,color:#fff
    classDef success fill:#bbf7d0,stroke:#166534
    classDef warning fill:#fef08a,stroke:#854d0e
    class Max primary
    class Budget,NonNeg warning
    class Tangency,Corner primary
    class Optimal success
```
