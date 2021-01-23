import React, {Fragment} from 'react';
import ReactDOM from 'react-dom';

class FilePreviewDashboard extends React.Component {

    render() {
        return (
            <Fragment>
                <span id="status">No changes to save</span>
                <input type="checkbox" id="auto_save" style={{marginLeft: 100}}/> Auto save
            </Fragment>
        );
    }
}

export default FilePreviewDashboard;

if (document.getElementById('file_preview_dashboard')) {
    ReactDOM.render(<FilePreviewDashboard/>, document.getElementById('file_preview_dashboard'));
}
