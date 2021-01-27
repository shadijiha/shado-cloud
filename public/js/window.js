/**
 *
 */

class Window {
    constructor(title, actions, body) {
        this.title = title || "Alert";
        this.actions = actions || [{
            value: "OK",
            onclick: this.close,
        }];

        this.id = "window_" + Math.floor(Math.random() * 1e6);
        this.body = body || function () {
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
        body_container.innerHTML = this.body();

        // Close button action
        close_btn.classList.add("close_btn");
        close_btn.innerText = "X";
        close_btn.setAttribute("onclick", `document.body.removeChild(document.getElementById('${this.id}'))`)

        title_bar.classList.add("title_bar");
        title_bar.appendChild(close_btn);

        body_container.classList.add("body_container");

        action_container.classList.add("action_container");

        DIV.appendChild(title_bar);
        DIV.appendChild(body_container);
        DIV.appendChild(action_container);

        // Add action buttons
        for (const action of this.actions) {
            const temp = document.createElement("button");
            temp.classList.add("action_btn");
            temp.innerText = action.value;
            temp.addEventListener("click", action.onclick);
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
        console.log(document.getElementById(this.id));
        document.body.removeChild(this._dom);
    }

}
