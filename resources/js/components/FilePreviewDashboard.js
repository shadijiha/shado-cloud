import React, {Fragment} from 'react';
import ReactDOM from 'react-dom';

class FilePreviewDashboard extends React.Component {

    constructor(props) {
        super(props);

        //Bind
        this.input = React.createRef();
        this.copyURL = this.copyURL.bind(this);

        // Redirect console log
        if (typeof console != "undefined")
            if (typeof console.log != 'undefined')
                console.olog = console.log;
            else
                console.olog = function () {
                };

        console.log = function (message) {
            console.olog(message);
            document.getElementById("debugDiv").innerHTML += "<div>" + message + "</div>";
        };
        console.error = console.debug = console.info = console.log;
    }

    runScript() {
        const script = document.getElementById("file_content").innerText;
        try {
            eval(script);
        } catch (e) {
            console.log(`<span style="color: #b30400">${e}</span>`);
        }
    }

    copyURL() {
        selectText('api_file_url')
        document.execCommand('copy');
        // This is just personal preference.
        // I prefer to not show the whole text area selected.
    }

    render() {
        return (
            <Fragment>
                <button onClick={this.runScript} className="run_btn">
                    <i className="fas fa-play"></i>
                    Run script
                </button>
                <label className="switch" title="Toggle auto save">
                    <input type="checkbox" defaultChecked={true} id="auto_save"/>
                    <span className="slider round"></span>
                </label>
                <span id="status" style={{marginLeft: 20}}>No changes to save</span>
                <br/>
                <div>
                    <div className="url" id="api_file_url" ref={this.input} onClick={this.copyURL}>{file.url}</div>
                </div>
            </Fragment>
        );
    }
}

export default FilePreviewDashboard;

if (document.getElementById('file_preview_dashboard')) {
    ReactDOM.render(<FilePreviewDashboard/>, document.getElementById('file_preview_dashboard'));
}
