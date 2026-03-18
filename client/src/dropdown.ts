import "./dropdown.css";

/** Custom styled dropdown to replace native <select> */

export interface DropdownOption {
  value: string;
  label: string;
}

export interface Dropdown {
  el: HTMLElement;
  value: string;
  setOptions(options: DropdownOption[]): void;
  setValue(value: string): void;
  onChange: ((value: string) => void) | null;
}

export function createDropdown(
  placeholder: string,
  className = "",
): Dropdown {
  const el = document.createElement("div");
  el.className = `dropdown ${className}`;

  const trigger = document.createElement("button");
  trigger.className = "dropdown-trigger";
  trigger.textContent = placeholder;

  const menu = document.createElement("div");
  menu.className = "dropdown-menu";

  el.appendChild(trigger);
  el.appendChild(menu);

  let options: DropdownOption[] = [];
  let current = "";
  let open = false;
  let onChange: ((value: string) => void) | null = null;

  function close() {
    open = false;
    menu.classList.remove("open");
  }

  function toggle() {
    open = !open;
    menu.classList.toggle("open", open);
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    toggle();
  });

  document.addEventListener("click", () => {
    if (open) close();
  });

  function render() {
    menu.innerHTML = "";
    for (const opt of options) {
      const item = document.createElement("button");
      item.className = `dropdown-item${opt.value === current ? " active" : ""}`;
      item.textContent = opt.label;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        current = opt.value;
        trigger.textContent = opt.label;
        close();
        render();
        onChange?.(current);
      });
      menu.appendChild(item);
    }
  }

  return {
    el,
    get value() {
      return current;
    },
    set onChange(fn: ((value: string) => void) | null) {
      onChange = fn;
    },
    get onChange() {
      return onChange;
    },
    setOptions(opts: DropdownOption[]) {
      options = opts;
      render();
      // update label if current value still exists
      const match = options.find((o) => o.value === current);
      if (match) trigger.textContent = match.label;
      else if (!current) trigger.textContent = placeholder;
    },
    setValue(value: string) {
      current = value;
      const match = options.find((o) => o.value === value);
      trigger.textContent = match ? match.label : placeholder;
      render();
    },
  };
}
