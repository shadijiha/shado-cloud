/**
 *
 */
import React from 'react';
import ReactDOM from 'react-dom';

class NewFileManager {
    static async createFolder(name) {
        name = name || "folder " + new Date().toDateString().replaceAll(/:|\\|\//g, " ");
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
            if (json.code != 200) {
                new Window("Error", null, function () {
                    return json.message;
                });
            }
        }
    }

    static async createFile() {
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

            if (json.code != 200) {
                new Window("Error", null, function () {
                    return json.message;
                });
            }
        }
    }

    static async copyFileFromURL(url) {
        const response = await fetch(`${Routes.api}/copytodrive?path=${CURRENT_PATH}&url=${url}`);
        const json = await response.json();

        if (json.code != 200) {
            new Window("Error!", null, () => {
                return json.message;
            });
            return false;
        }
        return true;
    }
}

class NewMenu extends React.Component {

    constructor(props) {
        super(props);
    }

    createFolderWindow() {
        new Window("Create new folder", [
                Window.CANCEL_BUTTON,
                {
                    value: "OK",
                    onclick: (self) => {
                        NewFileManager.createFolder(document.getElementById("input_" + self.id).value);
                        self.close();
                        window.location.reload();
                    }
                }],
            function (self) {
                return `
                    <p>Chose a name for your folder</p>
                    <input type="type" id="input_${self.id}" placeholder="${"folder " + new Date().toDateString().replaceAll(/:|\\|\//g, " ")}" />
                `;
            });
    }

    uploadFileWindow() {
        new Window("Upload file", [
            Window.CANCEL_BUTTON,
            {
                value: "OK",
                onclick: function () {
                    console.log(document.getElementById("uploadFileForm"));
                    document.getElementById("uploadFileForm").submit();
                }
            }], () => {
            return `
                <form id="uploadFileForm" action="${Routes.uploadFile}" method="POST" enctype="multipart/form-data">
                    <input type="hidden" name="_token" value="${csrf_token}" />
                    <input type="hidden" name="path" value="${CURRENT_PATH}">
                    <input type="file" name="data" />
                </form>
            `;
        });
    }

    copyFileWindow() {
        new Window("Copy file from URL", [
            Window.CANCEL_BUTTON,
            {
                value: "OK",
                onclick: function (self) {
                    const result = NewFileManager.copyFileFromURL(document.getElementById("input_" + self.id).value);

                    if (result) {
                        self.close();
                        window.location.reload();
                    }
                }
            }
        ], function (self) {
            return `
                URL to copy from:
                <br />
                <br />
                <input id="input_${self.id}" placeholder="URL..." type="text" />
            `;
        });
    }

    hideNewMenu() {
        document.getElementById("context_menu").style.display = "none";
    }

    render() {
        return (
            <div id="context_menu" onMouseLeave={this.hideNewMenu}>
                <ul>
                    <li onClick={this.uploadFileWindow}>
                        <i className="fas fa-file-upload"></i> Upload file
                    </li>
                    <li onClick={this.copyFileWindow}>
                        <i className="fas fa-copy"></i> Copy file from URL
                    </li>
                    <hr/>
                    <li onClick={this.createFolderWindow}>
                        <i className="fas fa-folder-plus"></i> New folder
                    </li>
                    <li onClick={NewFileManager.createFile}>
                        <i className="fas fa-file-medical"></i> New file
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
