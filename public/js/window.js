/**
 *
 */

class Window {

    static OK_BUTTON = {
        value: "OK",
        onclick: (self) => {
            document.body.removeChild(self._dom)
        },
    };
    static CANCEL_BUTTON = {
        value: "Cancel",
        onclick: (self) => {
            document.body.removeChild(self._dom)
        },
    }

    constructor(title, actions, body) {
        this.title = title || "Alert";
        this.actions = actions || [Window.OK_BUTTON];

        this.id = "window_" + Math.floor(Math.random() * 1e6);
        this.body = body || function (self) {
            return "This is a simple window";
        };

        this._dom = null;

        this.render();
    }

    render() {
        let DIV = document.createElement("div");
        DIV.classList.add("alertContainer");
        DIV.id = this.id;

        const title_bar = document.createElement("div");
        const body_container = document.createElement("div");
        const action_container = document.createElement("div");
        const close_btn = document.createElement("button");

        title_bar.innerHTML = this.title;

        // Setup body
        let __self = this;
        body_container.innerHTML = this.body(__self);

        // Close button action
        close_btn.classList.add("close_btn");
        close_btn.innerText = "X";
        close_btn.addEventListener("click", () => {
            this.close();
        });

        // Setup title bar
        title_bar.classList.add("title_bar");
        title_bar.appendChild(close_btn);


        body_container.classList.add("body_container");
        action_container.classList.add("action_container");

        // Add all to parent
        DIV.appendChild(title_bar);
        DIV.appendChild(body_container);
        DIV.appendChild(action_container);

        // Add action buttons
        for (const action of this.actions) {
            const temp = document.createElement("button");
            temp.classList.add("action_btn");
            temp.innerText = action.value;

            // Add event listener
            const self = this;
            temp.addEventListener("click", function () {
                action.onclick(self);
            });
            temp.addEventListener("mouseover", function () {
                if (action.onmouseover)
                    action.onmouseover(self);
            });
            temp.addEventListener("mouseout", function () {
                if (action.onmouseout)
                    action.onmouseout(self);
            });

            action_container.appendChild(temp);
        }

        if (document.readyState === "complete") {
            document.body.appendChild(DIV);
        } else {
            window.addEventListener("load", function () {
                document.body.appendChild(DIV);
            });
        }

        this._dom = DIV;
    }

    close() {
        document.body.removeChild(this._dom);
    }

}

Window.ActionButton = class {
    constructor(value) {
        this.value = value;
        this.onclick = function (win) {
            win.close();
        }
        this.onmouseover = function (win) {
        }
        this.onmouseout = this.onmouseover;
    }

    setValue(value) {
        this.value = value;
    }

    setOnclick(func) {
        this.onclick = func;
    }

    setOnMouseOver(func) {
        this.onmouseover = func;
    }

    setOnMouseOut(func) {
        this.onmouseout = func;
    }
}
