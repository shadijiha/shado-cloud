/**
 *
 */
import React from 'react';
import ReactDOM from 'react-dom';

class NewMenu extends React.Component {

    async createFolder() {
        const name = "folder " + new Date().toDateString().replaceAll(/:|\\|\//g, " ");
        if (CURRENT_PATH !== "") {
            // Send request to the API
            const response = await fetch(`${Routes.createDir}`, {
                method: "POST",
                headers: {
                    "content-Type": "application/json",
                    'X-CSRF-TOKEN': csrf_token,
                },
                body: JSON.stringify({
                    path: `${CURRENT_PATH}/${name}`,
                })
            });
            const json = await response.json();
        }
    }


    async createFile() {
        const name = "file " + new Date().toDateString().replaceAll(/:|\\|\//g, " ");
        if (CURRENT_PATH !== "") {
            // Send request to the API
            const response = await fetch(`${Routes.index}/api`, {
                method: "POST",
                headers: {
                    "content-Type": "application/json",
                    'X-CSRF-TOKEN': csrf_token,
                },
                body: JSON.stringify({
                    path: `${CURRENT_PATH}/${name}.txt`,
                    data: "",
                })
            });
            const json = await response.json();
            alert(JSON.stringify(json));
        }
    }

    hideNewMenu() {
        document.getElementById("context_menu").style.display = "none";
    }

    render() {
        return (
            <div id="context_menu" onMouseLeave={this.hideNewMenu}>
                <ul>
                    <li onClick={this.createFolder}>
                        New folder
                    </li>
                    <li onClick={this.createFile}>
                        New file
                    </li>
                </ul>
            </div>
        );
    }
}

class Sidebar extends React.Component {

    constructor(props) {
        super(props);
    }

    showNewMenu() {
        const DIV = document.getElementById("context_menu");
        DIV.style.display = "block";
        DIV.style.left = mouse.x + "px";
        DIV.style.top = mouse.y - 50 + "px";
    }

    render() {
        return (
            <React.Fragment>
                <h3>Menu</h3>
                <a href="#" onClick={this.showNewMenu}>
                    <i className="fas fa-plus"></i>
                    <span> New</span>
                </a>
                <a href={Routes.index}>
                    <i className="fas fa-folder-open"/>
                    <span> Projects</span>
                </a>
                <a href={Routes.recent}>
                    <i className="fas fa-clock"/>
                    <span> Recent</span>
                </a>
                <a href={Routes.settings}>
                    <i className="fas fa-cog"/>
                    <span> Settings</span>
                </a>

                <NewMenu/>

            </React.Fragment>
        );
    }
}

export default Sidebar;

if (document.getElementById('sidebar')) {
    ReactDOM.render(<Sidebar/>, document.getElementById('sidebar'));
}
